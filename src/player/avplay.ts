// Samsung Tizen AVPlay engine. The native, hardware-accelerated pipeline on
// Smart TVs — decodes the catalog's 4K HEVC packages without the
// software-decode crawl an MSE/hls.js path can hit on a TV WebKit. AVPlay
// plays the HLS master URL directly (it has its own HLS demuxer), so we hand
// it the same `…/play/master.m3u8?stream=&caps=&q=` URL the hls engine gets.
//
// AVPlay is a singleton native object (`webapis.avplay`) bound to ONE on-page
// <object type="application/avplayer">. We create that object inside the
// container element, drive AVPlay through its lifecycle (open → prepare →
// play), and translate AVPlay's listener callbacks into our PlayerEvent fan-
// out. Off-device this file is never constructed (createPlayer routes to the
// hls engine), but every call is still guarded so a partial/absent AVPlay
// surface degrades to a no-op instead of throwing.
//
// AVPlay state machine (per Samsung docs):
//   NONE → open(url) → IDLE → prepare()/prepareAsync() → READY → play() →
//   PLAYING ⇄ pause()/PAUSED, stop()/IDLE. seekTo(ms) works in READY/PLAYING/
//   PAUSED. close() returns to NONE and frees the decoder.

import { needsUhdDecoder } from './caps';
import type {
  ChinoPlayer,
  LoadOptions,
  PlayerAudioTrack,
  PlayerEvent,
  PlayerTextTrack,
} from './types';

// Minimal structural typing for the AVPlay surface we touch. The ambient
// window.webapis.avplay is `unknown` on purpose (the full surface is huge);
// we narrow only what we use and guard every call.
interface AVPlayListener {
  onbufferingstart?: () => void;
  onbufferingprogress?: (percent: number) => void;
  onbufferingcomplete?: () => void;
  oncurrentplaytime?: (ms: number) => void;
  onstreamcompleted?: () => void;
  onerror?: (err: string) => void;
  onevent?: (type: string, data: string) => void;
  onsubtitlechange?: (ms: number, text: string, type: number, attr: unknown) => void;
}

interface AVPlayTrackInfo {
  index: number;
  type: string; // 'VIDEO' | 'AUDIO' | 'TEXT'
  extra_info?: string;
}

interface AVPlayApi {
  open(url: string): void;
  close(): void;
  prepare(): void;
  prepareAsync(onsuccess: () => void, onerror?: (e: unknown) => void): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(ms: number): void;
  jumpForward?(ms: number): void;
  jumpBackward?(ms: number): void;
  getDuration(): number;
  getCurrentTime(): number;
  getState(): string;
  setDisplayRect(x: number, y: number, w: number, h: number): void;
  setListener(l: AVPlayListener): void;
  getTotalTrackInfo(): AVPlayTrackInfo[];
  setSelectTrack(type: string, index: number): void;
  setStreamingProperty?(type: string, value: string): void;
  setExternalSubtitlePath?(path: string): void;
  setSubtitlePosition?(ms: number): void;
}

function avplayApi(): AVPlayApi | null {
  const api = (window.webapis as unknown as { avplay?: AVPlayApi })?.avplay;
  return api ?? null;
}

export class AvplayEngine implements ChinoPlayer {
  private api: AVPlayApi | null = null;
  private objectEl: HTMLObjectElement | null = null;
  private container: HTMLElement | null = null;

  private listeners = new Map<PlayerEvent, Set<(d?: unknown) => void>>();
  private firstFrameFired = false;
  private durationMs = 0;
  private currentMs = 0;
  // Cached track info, refreshed on prepare-complete. Audio/text selection
  // maps our string ids back to AVPlay track indices.
  private tracks: AVPlayTrackInfo[] = [];

  attach(el: HTMLElement): void {
    this.container = el;
    // AVPlay renders to a native <object type="application/avplayer">. It
    // sits behind any DOM chrome the screen overlays; we size it to fill the
    // container and set the display rect to match on prepare.
    const obj = document.createElement('object');
    obj.setAttribute('type', 'application/avplayer');
    obj.style.position = 'absolute';
    obj.style.inset = '0';
    obj.style.width = '100%';
    obj.style.height = '100%';
    el.appendChild(obj);
    this.objectEl = obj;
    this.api = avplayApi();
  }

  async load(url: string, o?: LoadOptions): Promise<void> {
    const api = this.api;
    if (!api || !url) return;
    const startSec = o?.startSec ?? 0;
    this.firstFrameFired = false;
    this.durationMs = 0;
    this.currentMs = 0;
    this.emit('buffering');

    // A fresh load reuses the singleton — stop + close any prior session so
    // the decoder is free before re-opening.
    try {
      const state = api.getState?.();
      if (state && state !== 'NONE' && state !== 'IDLE') api.stop();
    } catch { /* ignore */ }
    try { api.close(); } catch { /* first open — nothing to close */ }

    try {
      api.open(url);
    } catch (e) {
      this.emit('error', { message: 'Could not open stream.', tech: String(e) });
      return;
    }

    // No ADAPTIVE_INFO — re-checked now that a packaged master is a ladder
    // (q=auto), not one variant. Samsung's AVPlay reference and adaptive
    // streaming guide describe it as optional steering of AVPlay's own
    // adaptation, which runs without it:
    //   BITRATES      bounds the variants AVPlay may pick. The server already
    //                 serves only the rungs this TV decodes (?caps=), so a
    //                 range could only cut rungs it chose to serve; the old
    //                 BITRATES=2000~10000 (kbps, as Samsung's examples read)
    //                 starved the 12.6–14.6 Mbps 4K/8K rungs.
    //   STARTBITRATE  where adaptation starts (LOWEST, HIGHEST, AVERAGE or a
    //                 rate). The master's first variant is its top rung, the
    //                 one the server warms; where AVPlay starts unasked is not
    //                 documented, so HIGHEST waits for a device to show it
    //                 is worth it.
    //   FIXED_MAX_RESOLUTION (Tizen 5.0+)  per Samsung only for 4K/8K
    //                 manifests that do not state their resolutions; every
    //                 variant of ours carries RESOLUTION.
    // So Auto is AVPlay's own adaptation over the served ladder, and a pick
    // (q=<rung>) a master of that rung alone. Needs a device check: a 4K/8K
    // rung on a capable panel should play at its full rate.
    //
    // SET_MODE_4K is the one property Samsung's docs do ask for: before Tizen
    // 5.0, 4K UHD streaming — and an adaptive stream switching up to a 4K
    // rung — needs the UHD decoder forced (streaming Q&A). On a UHD panel
    // of a 2018 set the ladder can hold 2160 rungs (?caps= lets them in),
    // so it is set there; from Tizen 5.0 it is deprecated for retail TVs and
    // not set. Like every streaming property it is set in IDLE, after open().
    if (needsUhdDecoder()) {
      try {
        api.setStreamingProperty?.('SET_MODE_4K', 'TRUE');
      } catch { /* firmware without the property — AVPlay picks the decoder */ }
    }

    this.installListener(startSec);
    this.syncDisplayRect();

    return new Promise<void>((resolve) => {
      const onReady = () => {
        try {
          this.durationMs = api.getDuration?.() ?? 0;
          this.tracks = this.safeTrackInfo();
        } catch { /* ignore */ }
        this.emit('ready', { duration: this.duration() });
        // Auto-resume seek before play (chino-web parity — start mid-stream
        // when a resume position was passed).
        if (startSec > 1) {
          try { api.seekTo(Math.floor(startSec * 1000)); } catch { /* ignore */ }
        }
        try { api.play(); } catch { /* ignore */ }
        resolve();
      };
      const onPrepareErr = (e: unknown) => {
        this.emit('error', { message: 'Could not prepare stream.', tech: String(e) });
        resolve();
      };
      try {
        if (typeof api.prepareAsync === 'function') {
          api.prepareAsync(onReady, onPrepareErr);
        } else {
          api.prepare();
          onReady();
        }
      } catch (e) {
        onPrepareErr(e);
      }
    });
  }

  play(): void {
    try {
      this.api?.play();
      this.resumed();
    } catch { /* ignore */ }
  }

  pause(): void {
    try { this.api?.pause(); this.emit('paused'); } catch { /* ignore */ }
  }

  togglePlay(): void {
    const api = this.api;
    if (!api) return;
    try {
      const state = api.getState();
      if (state === 'PLAYING') { api.pause(); this.emit('paused'); }
      else { api.play(); this.resumed(); }
    } catch { /* ignore */ }
  }

  // A resume from pause gets no buffering callback (the decoder has its data),
  // so say 'playing' here — otherwise the screen stays "paused" and stops
  // saving the resume position after the first pause. Before the first frame
  // the buffering callbacks report playback themselves.
  private resumed(): void {
    if (this.firstFrameFired) this.emit('playing');
  }

  seek(sec: number): void {
    const api = this.api;
    if (!api) return;
    const dur = this.duration();
    const clampedSec = Math.max(0, dur > 0 ? Math.min(dur, sec) : sec);
    try {
      api.seekTo(Math.floor(clampedSec * 1000));
      this.emit('buffering');
    } catch { /* ignore */ }
  }

  currentTime(): number {
    // oncurrentplaytime keeps currentMs fresh; fall back to a direct read.
    if (this.currentMs > 0) return this.currentMs / 1000;
    try { return (this.api?.getCurrentTime?.() ?? 0) / 1000; } catch { return 0; }
  }

  duration(): number {
    if (this.durationMs > 0) return this.durationMs / 1000;
    try {
      const d = this.api?.getDuration?.() ?? 0;
      return d > 0 ? d / 1000 : 0;
    } catch { return 0; }
  }

  setQuality(_id: string): void {
    // A quality pick is a master-URL reload the screen drives (re-calls
    // load() with a new ?q=). AVPlay has no variant selector (Samsung:
    // "Switching the audio quality or video resolution during playback is
    // not supported"), so this is a no-op; within a ladder it adapts alone.
    void _id;
  }

  audioTracks(): PlayerAudioTrack[] {
    return this.tracks
      .filter((t) => t.type === 'AUDIO')
      .map((t) => ({ id: String(t.index), label: this.trackLabel(t) }));
  }

  setAudioTrack(id: string): void {
    const idx = Number(id);
    if (!Number.isInteger(idx)) return;
    try { this.api?.setSelectTrack('AUDIO', idx); } catch { /* ignore */ }
  }

  // AVPlay's own TEXT tracks are the ones inside the stream; AVPlay draws
  // none of them (it would hand their text to onsubtitlechange). The player
  // screen offers chino-api's subtitles instead — the sidecars and embedded
  // streams chino-web offers — and draws them in its own overlay, so these two
  // methods only serve the engine contract.
  textTracks(): PlayerTextTrack[] {
    return this.tracks
      .filter((t) => t.type === 'TEXT')
      .map((t) => ({ id: String(t.index), label: this.trackLabel(t) }));
  }

  setTextTrack(id: string | null): void {
    const api = this.api;
    if (!api) return;
    if (id === null) {
      // AVPlay has no universal "disable subtitles" call; selecting a
      // non-existent index hides the overlay on most firmwares. Where
      // setSelectTrack throws we swallow it — the screen still reflects
      // "off" in its own state.
      try { api.setSelectTrack('TEXT', -1); } catch { /* ignore */ }
      return;
    }
    const idx = Number(id);
    if (!Number.isInteger(idx)) return;
    try { api.setSelectTrack('TEXT', idx); } catch { /* ignore */ }
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
    const api = this.api;
    if (api) {
      try {
        const state = api.getState?.();
        if (state && state !== 'NONE' && state !== 'IDLE') api.stop();
      } catch { /* ignore */ }
      try { api.close(); } catch { /* ignore */ }
    }
    this.objectEl?.remove();
    this.objectEl = null;
    this.api = null;
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

  // Match AVPlay's display rect to the container so the native plane fills
  // the screen. AVPlay wants integer device pixels, not CSS percentages.
  private syncDisplayRect(): void {
    const api = this.api;
    const el = this.container;
    if (!api || !el) return;
    try {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width) || window.innerWidth || 1920;
      const h = Math.round(r.height) || window.innerHeight || 1080;
      api.setDisplayRect(Math.round(r.left), Math.round(r.top), w, h);
    } catch { /* ignore — some firmwares reject rects before prepare */ }
  }

  private installListener(_startSec: number): void {
    const api = this.api;
    if (!api) return;
    const listener: AVPlayListener = {
      onbufferingstart: () => this.emit('buffering'),
      onbufferingprogress: () => { /* progress %, no overlay update needed */ },
      onbufferingcomplete: () => {
        this.emit('playing');
        if (!this.firstFrameFired) {
          this.firstFrameFired = true;
          this.emit('firstframe');
        }
      },
      oncurrentplaytime: (ms: number) => {
        this.currentMs = ms;
        // First real playtime tick also signals the first painted frame on
        // firmwares that don't fire onbufferingcomplete promptly.
        if (!this.firstFrameFired && ms >= 0) {
          this.firstFrameFired = true;
          this.emit('playing');
          this.emit('firstframe');
        }
        this.emit('timeupdate', ms / 1000);
      },
      onstreamcompleted: () => this.emit('ended'),
      onerror: (err: string) => this.emit('error', { message: 'Playback error.', tech: err }),
      onevent: (type: string) => {
        // PLAYER_MSG_* events; the resolution-change / bitrate-change ones
        // are informational. Treat an explicit resume event as playing.
        if (type === 'PLAYER_MSG_RESUME_DONE') this.emit('playing');
      },
    };
    try { api.setListener(listener); } catch { /* ignore */ }
  }

  private safeTrackInfo(): AVPlayTrackInfo[] {
    try {
      const info = this.api?.getTotalTrackInfo?.();
      return Array.isArray(info) ? info : [];
    } catch {
      return [];
    }
  }

  // AVPlay reports track metadata as a JSON string in extra_info (codec,
  // language, etc). Pull a human label out of it, falling back to a generic
  // index label.
  private trackLabel(t: AVPlayTrackInfo): string {
    try {
      if (t.extra_info) {
        const meta = JSON.parse(t.extra_info) as Record<string, unknown>;
        const lang = (meta.language ?? meta.lang) as string | undefined;
        const name = (meta.track_name ?? meta.name) as string | undefined;
        if (name && name.trim()) return name.trim();
        if (lang && String(lang).trim() && String(lang) !== 'und') return String(lang);
      }
    } catch { /* extra_info wasn't JSON on this firmware — fall through */ }
    return t.type === 'AUDIO' ? `Audio ${t.index + 1}` : `Subtitle ${t.index + 1}`;
  }
}
