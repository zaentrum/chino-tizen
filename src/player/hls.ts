// hls.js + HTMLVideoElement engine. The off-device default (desktop dev) and
// the on-device fallback when AVPlay can't decode a stream. Mirrors
// chino-web's PlayerPage hls.js configuration (buffer caps, retry knobs,
// circuit-breaker error handling) and draws PGS subtitles with libpgs-js's
// canvas overlay. Text subtitles (webvtt/srt) are drawn by the player
// screen's own overlay, the same on both engines — a .srt sidecar cannot ride
// a native <track>, and AVPlay has no renderer at all.
//
// Single-variant ladder: chino-stream's master.m3u8 emits ONE video variant
// matching ?q=. Changing quality therefore means reloading a different master
// URL — that's the screen's job (it rebuilds the URL and calls load() again);
// setQuality() here only steers hls.js's own ABR level when the manifest
// happens to carry multiple levels (it normally doesn't).

import Hls from 'hls.js';
import { PgsRenderer } from 'libpgs';
// Vite resolves this to an emitted asset URL; the worker file is already an
// IIFE so it loads via `new Worker(url)` with no extra glue. Keeps libpgs's
// worker out of the main bundle. Mirror of chino-web's import.
import libpgsWorkerUrl from 'libpgs/dist/libpgs.worker.js?url';
import type {
  ChinoPlayer,
  LoadOptions,
  PlayerAudioTrack,
  PlayerEvent,
  PlayerSubtitle,
  PlayerTextTrack,
  SubtitleCapableEngine,
} from './types';

export class HlsEngine implements ChinoPlayer, SubtitleCapableEngine {
  private video: HTMLVideoElement | null = null;
  private hls: Hls | null = null;
  private container: HTMLElement | null = null;

  // libpgs renderer for the active PGS sidecar; one alive at a time.
  private pgs: PgsRenderer | null = null;
  private pgsCanvas: HTMLCanvasElement | null = null;

  // The PGS tracks the screen may select (text tracks never reach the engine).
  private subs: PlayerSubtitle[] = [];
  // The PGS track being drawn (null = none).
  private activeSubId: string | null = null;

  // Event fan-out. Keyed by PlayerEvent; each value is a Set of callbacks.
  private listeners = new Map<PlayerEvent, Set<(d?: unknown) => void>>();
  private firstFrameFired = false;

  // Circuit-breaker bookkeeping, mirrored from chino-web's hls ERROR handler.
  private mediaRecoverCount = 0;
  private mediaRecoverFirst = 0;
  private networkRetryCount = 0;
  private networkRetryFirst = 0;

  attach(el: HTMLElement): void {
    this.container = el;
    const v = document.createElement('video');
    // No `src` attribute — hls.js attaches and drives the source. On a
    // native-HLS-only runtime we set v.src directly in load().
    v.className = 'absolute inset-0 w-full h-full bg-black';
    v.setAttribute('playsinline', '');
    // crossOrigin matches chino-web — required so <track> cues + any canvas
    // readback (libpgs) aren't tainted.
    v.crossOrigin = 'anonymous';
    v.style.width = '100%';
    v.style.height = '100%';
    v.style.objectFit = 'contain';
    this.bindVideoEvents(v);
    el.appendChild(v);

    // Canvas sibling for PGS. Positioned over the video; libpgs owns its
    // draw loop and syncs to the video's timeupdate internally.
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    el.appendChild(canvas);
    this.pgsCanvas = canvas;

    this.video = v;
  }

  async load(url: string, o?: LoadOptions): Promise<void> {
    const v = this.video;
    if (!v || !url) return;
    const startSec = o?.startSec ?? 0;
    this.firstFrameFired = false;
    this.emit('buffering');

    // Seek-to-resume once metadata lands. Bound once per load; AVPlay-style
    // resume parity (chino-web stashes the value in pendingSeekRef and
    // replays it from onLoadedMetadata).
    const onMeta = () => {
      this.emit('ready', { duration: this.duration() });
      if (startSec > 1 && isFinite(v.duration) && v.duration > 0) {
        try { v.currentTime = Math.min(startSec, v.duration - 1); } catch { /* ignore */ }
      }
      v.removeEventListener('loadedmetadata', onMeta);
    };
    v.addEventListener('loadedmetadata', onMeta);

    // Tear down any prior hls instance (quality switch / reload reuses the
    // same engine instance and calls load() again).
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    // Prefer hls.js (MSE) over native HLS — Chrome's canPlayType for the
    // HLS MIME returns "maybe" but doesn't actually decode the playlist.
    // Fall back to native HLS only when hls.js isn't supported AND the UA
    // reports it can play HLS (Safari / iOS / some TV WebKits).
    if (!Hls.isSupported()) {
      if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url;
        return;
      }
      this.emit('error', { message: 'No HLS support: hls.js unsupported and no native HLS.' });
      return;
    }

    // hls.js config copied from chino-web PlayerPage: a generous buffer to
    // ride out WiFi roams / brief upstream stalls / a chino-stream pod
    // restart, bounded by a 500 MB memory cap, plus bumped retry counts for
    // the HPA fan-out (segments may briefly 502 while a pod restarts).
    const hls = new Hls({
      maxBufferLength: 300,
      maxMaxBufferLength: 600,
      maxBufferSize: 500 * 1000 * 1000,
      backBufferLength: 60,
      manifestLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 4,
      fragLoadingRetryDelay: 1000,
      fragLoadingMaxRetry: 6,
    });
    hls.attachMedia(v);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));

    // Circuit-breaker error handling, mirrored from chino-web. Without it a
    // chronic codec / MSE-append error sends recoverMediaError into a hot
    // loop that hammers master.m3u8 dozens of times per second.
    this.mediaRecoverCount = 0;
    this.mediaRecoverFirst = 0;
    this.networkRetryCount = 0;
    this.networkRetryFirst = 0;
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) {
        // bufferAppendError is a permanent failure for this src — Chrome
        // rejects the MSE append and hls.js retries forever without firing
        // fatal. Promote it to fatal so the breaker can act.
        if (data.details === 'bufferAppendError' || data.details === 'bufferAppendingError') {
          (data as { fatal?: boolean }).fatal = true;
        } else {
          return;
        }
      }
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const techDetail = [
        'hls.js fatal error',
        `type: ${data.type}`,
        `details: ${data.details}`,
        data.reason ? `reason: ${data.reason}` : '',
      ].filter(Boolean).join('\n');
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          if (now - this.networkRetryFirst > 10_000) {
            this.networkRetryCount = 0;
            this.networkRetryFirst = now;
          }
          this.networkRetryCount += 1;
          if (this.networkRetryCount > 3) {
            hls.destroy();
            this.emit('error', { message: 'Stream unreachable — check your connection.', tech: techDetail });
            return;
          }
          hls.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          if (now - this.mediaRecoverFirst > 10_000) {
            this.mediaRecoverCount = 0;
            this.mediaRecoverFirst = now;
          }
          this.mediaRecoverCount += 1;
          if (this.mediaRecoverCount > 3) {
            hls.destroy();
            // On the TV the upstream owns the transcode-fallback decision
            // (re-load with a different ?q= / forced transcode). We surface
            // a decode error and let the screen decide whether to retry.
            this.emit('error', { message: 'Playback failed — this file could not be decoded.', tech: techDetail });
            return;
          }
          hls.recoverMediaError();
          break;
        default:
          hls.destroy();
          this.emit('error', { message: 'Playback failed unexpectedly.', tech: techDetail });
      }
    });

    this.hls = hls;
    // Re-mount any active PGS track now that a fresh source is loading.
    this.applySubtitle();
  }

  play(): void {
    this.video?.play().catch(() => undefined);
  }

  pause(): void {
    this.video?.pause();
  }

  togglePlay(): void {
    const v = this.video;
    if (!v) return;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  }

  seek(sec: number): void {
    const v = this.video;
    if (!v) return;
    const dur = this.duration();
    const clamped = Math.max(0, dur > 0 ? Math.min(dur, sec) : sec);
    try { v.currentTime = clamped; } catch { /* ignore */ }
  }

  currentTime(): number {
    return this.video?.currentTime ?? 0;
  }

  duration(): number {
    const d = this.video?.duration ?? 0;
    return isFinite(d) && d > 0 ? d : 0;
  }

  setQuality(id: string): void {
    // Our master playlist is single-variant per ?q=, so a real quality
    // change is a master-URL reload the screen drives. When the manifest
    // DOES carry multiple levels (e.g. a packaged multi-rendition item),
    // steer hls.js's level: 'auto'/'-1' → ABR, a numeric string → that level.
    const hls = this.hls;
    if (!hls) return;
    if (id === 'auto' || id === '-1') {
      hls.currentLevel = -1;
      return;
    }
    const n = Number(id);
    if (Number.isInteger(n) && n >= 0 && n < hls.levels.length) {
      hls.currentLevel = n;
    }
  }

  audioTracks(): PlayerAudioTrack[] {
    const hls = this.hls;
    if (!hls || !hls.audioTracks?.length) return [];
    return hls.audioTracks.map((t, i) => ({
      id: String(t.id ?? i),
      label: t.name || t.lang || `Track ${i + 1}`,
    }));
  }

  setAudioTrack(id: string): void {
    const hls = this.hls;
    if (!hls || !hls.audioTracks?.length) return;
    const idx = hls.audioTracks.findIndex((t, i) => String(t.id ?? i) === id);
    if (idx >= 0) hls.audioTrack = idx;
  }

  textTracks(): PlayerTextTrack[] {
    // The PGS tracks the screen handed in. The screen builds its subtitle
    // menu from chino-api's list itself (sidecars + embedded streams), not
    // from hls.js's in-manifest text tracks.
    return this.subs.map((s) => ({ id: s.id, label: s.label }));
  }

  setTextTrack(id: string | null): void {
    // An id that is not one of the PGS tracks (a text track, drawn by the
    // screen) turns the PGS overlay off.
    this.activeSubId = id && this.subs.some((s) => s.id === id) ? id : null;
    this.applySubtitle();
  }

  // SubtitleCapableEngine — the PGS tracks the screen may select. Anything
  // else is ignored: text tracks are the screen's overlay's.
  setSubtitles(subs: PlayerSubtitle[]): void {
    this.subs = subs.filter((s) => (s.format || '').toLowerCase() === 'pgs');
    // Re-assert whatever is currently selected against the new list.
    if (this.activeSubId && !this.subs.some((s) => s.id === this.activeSubId)) {
      this.activeSubId = null;
    }
    this.applySubtitle();
  }

  on(ev: PlayerEvent, cb: (d?: unknown) => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) {
      set = new Set();
      this.listeners.set(ev, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  destroy(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.disposePgs();
    const v = this.video;
    if (v) {
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch { /* ignore */ }
      v.remove();
    }
    this.pgsCanvas?.remove();
    this.pgsCanvas = null;
    this.video = null;
    this.container = null;
    this.listeners.clear();
  }

  // ---- internals ----

  private emit(ev: PlayerEvent, d?: unknown): void {
    const set = this.listeners.get(ev);
    if (!set) return;
    for (const cb of set) {
      try { cb(d); } catch { /* a listener throwing must not break the engine */ }
    }
  }

  private bindVideoEvents(v: HTMLVideoElement): void {
    v.addEventListener('playing', () => {
      this.emit('playing');
      if (!this.firstFrameFired) {
        this.firstFrameFired = true;
        this.emit('firstframe');
      }
    });
    v.addEventListener('pause', () => this.emit('paused'));
    v.addEventListener('timeupdate', () => this.emit('timeupdate', v.currentTime));
    v.addEventListener('ended', () => this.emit('ended'));
    v.addEventListener('waiting', () => this.emit('buffering'));
    v.addEventListener('canplay', () => {
      // Pair with onPause stall recovery (chino-web): once data is back,
      // clear buffering. firstframe also fires here for the native-HLS path,
      // which may not emit 'playing' before the first paint.
      this.emit('playing');
      if (!this.firstFrameFired && v.readyState >= 2) {
        this.firstFrameFired = true;
        this.emit('firstframe');
      }
    });
    v.addEventListener('error', () => {
      const e = v.error;
      this.emit('error', { message: e?.message || 'Media error', code: e?.code });
    });
  }

  // Mount / unmount the active PGS track on the libpgs canvas overlay. Only
  // ever one active at a time on the TV (no dual-subtitle on a 10-foot UI).
  private applySubtitle(): void {
    if (!this.video) return;
    const active = this.activeSubId
      ? this.subs.find((s) => s.id === this.activeSubId) ?? null
      : null;
    if (active) this.mountPgs(active);
    else this.disposePgs();
  }

  private mountPgs(sub: PlayerSubtitle): void {
    const v = this.video;
    const canvas = this.pgsCanvas;
    if (!v || !canvas) return;
    // Dispose any prior renderer (terminating its worker) before creating
    // the next — only one renderer is ever alive. libpgs's worker mode
    // transfers the canvas (one-way), so we recreate the canvas node to
    // avoid InvalidStateError on a re-mount.
    this.disposePgs();
    const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(fresh);
    this.pgsCanvas = fresh;
    this.pgs = new PgsRenderer({
      video: v,
      canvas: fresh,
      subUrl: sub.url,
      workerUrl: libpgsWorkerUrl,
      aspectRatio: 'contain',
    });
  }

  private disposePgs(): void {
    if (this.pgs) {
      try { this.pgs.dispose(); } catch { /* ignore */ }
      this.pgs = null;
    }
  }
}
