// Full-screen playback for the Tizen TV shell.
//
// Behaviour authority: chino-web's PlayerPage (the canonical playback flow —
// auto-resume, ~10s progress posting, skip-intro/credits with a countdown,
// quality / audio / subtitle menus, trickplay scrub preview, mark-watched on
// credits/95%, auto-play-next) and chino-androidtv's PlayerScreen +
// PlayerViewModel + Trickplay (the 10-foot UX — controls auto-hide while
// playing, UP shows them, any remote key re-shows them, DPAD seeks ±10s while
// hidden, media keys ±30s, no resume dialog, countdown auto-skip the DPAD can
// cancel).
//
// The screen drives the engine through the @/player ChinoPlayer surface only —
// the AVPlay (on-device hardware decode of the catalogue's 4K HEVC packages) ↔
// hls.js (desktop dev / on-device fallback) choice is invisible above this
// line. Everything interactive in the control overlay is a @/tv/focus
// focusable so the D-pad walks the chrome; transport + BACK are owned via
// useRemoteKey so they fire before the focus engine's arrow navigation.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  AudioLines,
  Captions,
  Check,
  ChevronRight,
  FastForward,
  Gauge,
  Loader2,
  Pause,
  Play,
  Rewind,
  SkipForward,
} from 'lucide-react';
import type { Item, PlayInfo, Segment } from '@/api/types';
import { api } from '@/api/instance';
import { authStore } from '@/auth/session';
import {
  createPlayer,
  detectCaps,
  type ChinoPlayer,
  type PlayerSubtitle,
  type SubtitleCapableEngine,
} from '@/player';
import {
  createProgressGuard,
  mayWriteProgress,
  resumeStartSec,
  type ProgressGuard,
} from '@/lib/progress';
import {
  buildSubtitleTracks,
  pickDefaultSubtitle,
  playingAudioLanguage,
  subtitleKind,
} from '@/lib/subtitles';
import { useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { navigate, back, useRoute } from '@/router';
import { useSettings } from '@/state/settings';
import { Spinner } from '@/components/Spinner';
import { SubtitleOverlay } from '@/components/SubtitleOverlay';

/* ──────────────────────────────  Tunables  ─────────────────────────────── */

/** Auto-hide the control overlay after this long without input while playing.
 *  Matches chino-androidtv's 4s grace; the web equivalent is ~3s. The contract
 *  asks for "~3s of no input while playing" so we land in the middle. */
const CHROME_HIDE_MS = 3_500;

/** DPAD LEFT/RIGHT seek step (controls hidden) — web parity. */
const SEEK_STEP_SEC = 10;

/** MEDIA_FAST_FORWARD / MEDIA_REWIND seek step — matches chino-androidtv's
 *  transport-key contract (±30s on the dedicated FF/REW remote buttons). */
const FF_STEP_SEC = 30;

/** Post the resume position this often while playing — chino-web + androidtv
 *  both upsert progress every ~10s plus once on teardown. */
const PROGRESS_INTERVAL_MS = 10_000;

/** Mark watched at this fraction of the runtime when there's no credits
 *  segment to trigger it first (web parity, p95). */
const WATCHED_THRESHOLD = 0.95;

/* ─────────────────────────  Trickplay (scrub preview)  ───────────────────
 * Faithful port of chino-web's lib/trickplay (parseTrickplayVTT /
 * findTrickplayCue) and androidtv's Trickplay.kt. The analyzer writes a WebVTT
 * cue file + sprite-sheet JPGs for every packaged item; each cue maps a time
 * range to one tile inside one sheet (`sprite-0001.jpg#xywh=x,y,w,h`). On
 * scrub-bar hover we translate the cursor → timestamp, find the cue, and crop
 * the sprite tile in. A 404 (item not packaged) degrades to a plain scrub bar:
 * the cue list stays empty and the preview never renders. */

interface TrickplayCue {
  /** Inclusive start, in seconds. */
  startSec: number;
  /** Exclusive end, in seconds. */
  endSec: number;
  /** Sprite-sheet filename, relative to the trickplay/ directory. */
  sprite: string;
  /** Pixel offsets of the tile inside its sprite sheet. */
  x: number;
  y: number;
  w: number;
  h: number;
}

const CUE_TIMING_RE =
  /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)\s+-->\s+(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
const PAYLOAD_RE = /^(.+?)#xywh=(\d+),(\d+),(\d+),(\d+)\s*$/;

/** Parse a WebVTT thumbnails file into a list of cues. Tolerant of a missing
 *  WEBVTT header + leading BOM; ignores cues whose payload isn't the expected
 *  `sprite.jpg#xywh=x,y,w,h` shape. */
function parseTrickplayVTT(text: string): TrickplayCue[] {
  const cues: TrickplayCue[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = CUE_TIMING_RE.exec(lines[i]);
    if (!m) continue;
    const startSec = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
    const endSec = +m[4] * 3600 + +m[5] * 60 + parseFloat(m[6]);
    // The payload sits on the next non-empty line.
    let payload = '';
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t) {
        payload = t;
        break;
      }
    }
    const p = PAYLOAD_RE.exec(payload);
    if (!p) continue;
    cues.push({
      startSec,
      endSec,
      sprite: p[1],
      x: +p[2],
      y: +p[3],
      w: +p[4],
      h: +p[5],
    });
  }
  return cues;
}

/** Find the cue covering `tSec`. Binary search — the scrub handler fires on
 *  every seek nudge, so the lookup has to stay cheap on long cue lists. */
function findTrickplayCue(cues: TrickplayCue[], tSec: number): TrickplayCue | null {
  if (cues.length === 0) return null;
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = cues[mid];
    if (tSec < c.startSec) hi = mid - 1;
    else if (tSec >= c.endSec) lo = mid + 1;
    else return c;
  }
  return null;
}

/* ──────────────────────────────  helpers  ──────────────────────────────── */

/** "1:23:45" (h:mm:ss over an hour) / "4:05" (m:ss otherwise). */
function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/** Title-case a segment kind for the skip button ("intro" → "Intro"). */
function kindLabel(kind: string): string {
  const k = kind.toLowerCase();
  if (k === 'intro') return 'Intro';
  if (k === 'credits') return 'Credits';
  if (k === 'recap') return 'Recap';
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** API root ending at `/api`, trailing slash stripped — same derivation the
 *  shared client uses, for the trickplay sprite URLs. */
function apiBase(): string {
  return (authStore.getApiBase() ?? '').replace(/\/+$/, '');
}

/**
 * The episode to auto-roll after this one: GET /v1/series/{parentId}/
 * next-episode?after={itemId} → { next: Item | null }. Best-effort — any
 * failure resolves to null and the caller falls back to BACK.
 */
async function fetchNextEpisodeId(parentId: string, afterItemId: string): Promise<string | null> {
  return api
    .nextEpisode(parentId, afterItemId)
    .then((r) => r.next?.id ?? null)
    .catch(() => null);
}

/* ──────────────────────────────  screen  ───────────────────────────────── */

/**
 * Full-screen player. Reads the catalogue id from `useRoute().params.id` plus
 * the `?resume=<sec>` / `?startover=1` query flags off window.location.search
 * (the router strips the query before matching, so we read it raw — same as the
 * search screen). On mount it fetches the item, the play info and a stream
 * token in parallel, builds the HLS master URL and loads it into a full-screen
 * <ChinoPlayer> with the resolved resume point. The rest is chrome.
 */
export default function PlayerScreen(): JSX.Element {
  const { params } = useRoute();
  const itemId = params.id ?? '';
  const { settings } = useSettings();

  // The full-screen surface the engine renders into (a <video> for hls, a
  // native <object> for AVPlay). The player binds to this on mount.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<ChinoPlayer | null>(null);

  // Load lifecycle.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<Item | null>(null);
  const [playInfo, setPlayInfo] = useState<PlayInfo | null>(null);

  // Stream token + caps captured once at mount; both feed every master URL
  // (re-used on a quality switch). Refs so the quality-switch closure reads
  // live values without re-binding.
  const streamTokenRef = useRef('');
  const capsRef = useRef('');

  // Quality currently requested (drives the master URL's ?q=). Seeded from the
  // server's default rung once playInfo lands.
  const [quality, setQuality] = useState<string>('');
  const qualityRef = useRef('');
  useEffect(() => {
    qualityRef.current = quality;
  }, [quality]);

  // Playback state mirrored off engine events (the engine is the source of
  // truth; React just reflects it for the chrome).
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [firstFrame, setFirstFrame] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  // Engine tracks become available after load(); read them off 'ready'.
  const [audioTracks, setAudioTracks] = useState<{ id: string; label: string }[]>([]);
  // Subtitles: chino-api's tracks, as chino-web offers them (@/lib/subtitles),
  // and the one on screen (null = off). Text tracks are drawn by
  // <SubtitleOverlay>; PGS only where the engine draws it (hls.js).
  const [subtitles, setSubtitles] = useState<PlayerSubtitle[]>([]);
  const [activeSubId, setActiveSubId] = useState<string | null>(null);

  // Segments (intro/credits/recap) for the skip affordance + auto-skip.
  const [segments, setSegments] = useState<Segment[]>([]);
  // Trickplay scrub-preview cues (empty when the item isn't packaged / 404).
  const [trickplayCues, setTrickplayCues] = useState<TrickplayCue[]>([]);

  // Effective duration: prefer the engine's parsed duration (the HLS playlist
  // sums each segment's EXTINF, matching the playable window); fall back to the
  // /play/info ffprobe value for fragmented modes whose duration isn't known
  // until late. Drives the scrub bar + the p95 watched threshold.
  const effectiveDuration = useMemo(() => {
    const fromEngine = isFinite(duration) && duration > 0 ? duration : 0;
    return fromEngine > 0 ? fromEngine : (playInfo?.duration_ms ?? 0) / 1000;
  }, [duration, playInfo]);

  // Control overlay visibility + which D-pad menu (if any) is open. At most one
  // menu is open at a time; while one is open the auto-hide timer is suspended
  // so it can't disappear mid-selection.
  const [chromeVisible, setChromeVisible] = useState(true);
  type MenuKey = 'audio' | 'subtitles' | 'quality';
  const [openMenu, setOpenMenu] = useState<MenuKey | null>(null);

  // Auto-skip countdown. Active while the playhead sits inside an intro/credits
  // segment AND the matching auto-skip setting is on AND the user hasn't
  // cancelled this segment. Any DPAD press cancels (sets the dismissed key).
  const [skipCountdown, setSkipCountdown] = useState<number | null>(null);
  const dismissedSegRef = useRef<Set<string>>(new Set());
  // Once-per-mount guards.
  const markedWatchedRef = useRef(false);
  const autoAdvancedRef = useRef(false);

  // Bump on any remote input to re-show the chrome + restart the hide timer.
  const [interactionTick, setInteractionTick] = useState(0);
  const noteInteraction = useCallback(() => setInteractionTick((n) => n + 1), []);

  // Refs the engine-event closures + intervals read so they aren't stale (the
  // listeners register once with []-deps).
  const durationRef = useRef(0);
  useEffect(() => {
    durationRef.current = effectiveDuration;
  }, [effectiveDuration]);

  // The resume position this session may write back (see @/lib/progress): fed
  // only from engine time updates while playing, never from the optimistic
  // `current` a seek sets. Null until the saved position has been read, so a
  // teardown before then writes nothing.
  const guardRef = useRef<ProgressGuard | null>(null);
  // Engine time updates count as "played to" from the first frame on and not
  // while paused (hls.js reports a seek made while paused as a time update).
  const firstFrameRef = useRef(false);
  const pausedRef = useRef(false);

  /* ── Force the document to pure black while mounted so any sliver around the
     stage shows black, not the shell's #0D1117. Mirrors chino-web. ── */
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prev = {
      htmlBg: html.style.backgroundColor,
      bodyBg: body.style.backgroundColor,
      bodyOverflow: body.style.overflow,
    };
    html.style.backgroundColor = '#000';
    body.style.backgroundColor = '#000';
    body.style.overflow = 'hidden';
    return () => {
      html.style.backgroundColor = prev.htmlBg;
      body.style.backgroundColor = prev.bodyBg;
      body.style.overflow = prev.bodyOverflow;
    };
  }, []);

  /* ── Post the resume position. Used by the ~10s interval AND once on
     teardown / BACK. keepalive on the underlying fetch lets the unmount POST
     survive the navigation. The position is the last second this session
     PLAYED to (the guard's) — never the head of a stream whose resume seek has
     not landed, never a seek target playback has not reached, never anything
     when the saved position could not be read. chino-api keeps one position
     per user, so a wrong write here loses the viewer's place everywhere. ── */
  const postProgressNow = useCallback(() => {
    const pos = guardRef.current?.position() ?? null;
    if (!itemId || pos == null) return;
    const dur = Math.floor(durationRef.current);
    void api.postProgress(itemId, pos, dur > 0 ? dur : 0).catch(() => undefined);
  }, [itemId]);

  /* ── Mount: fetch item + play info + stream token in parallel, build the
     master URL, create the engine and load it at the resolved resume point.
     Segments + trickplay are fetched alongside (best-effort, non-gating). ── */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !itemId) {
      if (!itemId) {
        setError('No item to play.');
        setLoading(false);
      }
      return undefined;
    }

    // Read the playback intent flags off the raw query — the router strips the
    // query before matching, so window.location.search is the source.
    const search = new URLSearchParams(window.location.search);
    const startover = search.get('startover') === '1';
    const resumeParam = Number(search.get('resume'));
    const resumeFromQuery =
      Number.isFinite(resumeParam) && resumeParam > 0 ? Math.floor(resumeParam) : 0;

    const caps = detectCaps();
    capsRef.current = caps;

    let cancelled = false;
    const player = createPlayer(stage);
    playerRef.current = player;

    // Engine event wiring. All registered before load() so the first frame /
    // ready / error can't be missed.
    const offReady = player.on('ready', () => {
      setDuration(player.duration());
      // Audio renditions become valid once the source is parsed.
      setAudioTracks(player.audioTracks());
    });
    const offPlaying = player.on('playing', () => {
      pausedRef.current = false;
      setPlaying(true);
      setBuffering(false);
    });
    const offPaused = player.on('paused', () => {
      pausedRef.current = true;
      setPlaying(false);
    });
    const offBuffering = player.on('buffering', () => setBuffering(true));
    const offFirstFrame = player.on('firstframe', () => {
      firstFrameRef.current = true;
      setFirstFrame(true);
      setBuffering(false);
    });
    const offTime = player.on('timeupdate', () => {
      const t = player.currentTime();
      setCurrent(t);
      // The engine's own playhead while playing is the only thing the resume
      // position is taken from.
      if (firstFrameRef.current && !pausedRef.current) guardRef.current?.played(t);
      // Duration can resolve after the first frame on fragmented streams.
      const d = player.duration();
      if (d > 0) setDuration(d);
    });
    const offEnded = player.on('ended', () => {
      setPlaying(false);
      void handleEnded();
    });
    const offError = player.on('error', () => {
      if (!cancelled) setError('Playback failed. This title could not be played.');
    });

    void (async () => {
      try {
        // The saved position comes from GET /items/{id}/progress — the item
        // payload carries none. null = it could not be read.
        const [loadedItem, info, token, savedSec, sidecars] = await Promise.all([
          api.getItem(itemId),
          api.playInfo(itemId, caps).catch(() => null),
          api.streamToken(),
          api.getProgress(itemId).catch(() => null),
          api.subtitles(itemId).catch(() => null),
        ]);
        if (cancelled) return;
        setItem(loadedItem);
        setPlayInfo(info);
        streamTokenRef.current = token;

        // Subtitles: the sidecars + the embedded text streams, labelled by
        // language. Off by default unless the audio is not in the preferred
        // subtitle language — then that language's track comes on. Should
        // /subtitles fail, the item's own rows still name the sidecars (their
        // url is the documented /api/v1/play/subs/{id}.vtt).
        const drawsPgs = 'setSubtitles' in player;
        const tracks = buildSubtitleTracks({
          itemId,
          sidecars: sidecars ?? loadedItem.subtitles ?? [],
          embedded: info?.subtitle_tracks ?? [],
          resolve: (path) => api.assetUrl(path, token) ?? path,
          pgs: drawsPgs,
        });
        const initialSub = pickDefaultSubtitle(tracks, {
          audioLang: playingAudioLanguage(info?.audio_tracks),
          preferredLang: settings.preferredSubtitleLang,
        });
        setSubtitles(tracks);
        setActiveSubId(initialSub);
        if (drawsPgs) {
          (player as ChinoPlayer & SubtitleCapableEngine).setSubtitles(tracks);
          player.setTextTrack(initialSub);
        }

        const resolvedQuality = info?.default_quality ?? '';
        setQuality(resolvedQuality);
        qualityRef.current = resolvedQuality;

        // Resolve the resume point (web/androidtv: auto-resume, no dialog):
        // ?startover=1 → the head; ?resume=<sec> (Zap hand-off) → exactly
        // there; else the saved position unless barely started or finished.
        // The finished test wants the real runtime: /play/info's, else the
        // catalogue's.
        const resume = {
          savedSec,
          durationSec: (info?.duration_ms || loadedItem.duration_ms || 0) / 1000,
          startover,
          handoffSec: resumeFromQuery,
        };
        const startSec = resumeStartSec(resume);
        // Arm the write guard before the stream starts: the head of the
        // stream, reported before the resume seek lands, must never be saved.
        const guard = createProgressGuard({ writable: mayWriteProgress(resume) });
        guard.expectSeek(startSec);
        guardRef.current = guard;

        const url = api.masterUrl(itemId, {
          streamToken: token,
          quality: resolvedQuality || undefined,
          caps,
        });
        setLoading(false);
        await player.load(url, { startSec: startSec > 0 ? startSec : undefined });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not start playback.');
          setLoading(false);
        }
      }
    })();

    // Segments + trickplay — best-effort, never gate playback.
    void api
      .segments(itemId)
      .then((s) => {
        if (!cancelled) setSegments(s);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      // Final progress post before the engine goes away (matches androidtv's
      // onDispose + chino-web's pagehide flush).
      postProgressNow();
      offReady();
      offPlaying();
      offPaused();
      offBuffering();
      offFirstFrame();
      offTime();
      offEnded();
      offError();
      player.destroy();
      playerRef.current = null;
    };
    // Mount-once: the player + listeners are reused across the play session.
    // itemId is stable for one mount (App keys the screen by the item id, so
    // a new id is a fresh mount with fresh refs). settings is read for the
    // initial preferred-sub pick only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  /* ── Trickplay VTT — fetch once the stream token + play info land, and only
     for packaged items (others 404 → degrade to a plain scrub bar). ── */
  useEffect(() => {
    const token = streamTokenRef.current;
    if (!token || !itemId) return undefined;
    // Wait for play info; skip non-packaged modes entirely so we don't log a
    // 404 on every play of an on-demand transcode item.
    if (playInfo && playInfo.mode && playInfo.mode !== 'packaged') {
      setTrickplayCues([]);
      return undefined;
    }
    if (!playInfo) return undefined;
    const ctrl = new AbortController();
    fetch(api.trickplayVttUrl(itemId, token), { signal: ctrl.signal })
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        if (text) setTrickplayCues(parseTrickplayVTT(text));
        else setTrickplayCues([]);
      })
      .catch(() => setTrickplayCues([]));
    return () => ctrl.abort();
  }, [itemId, playInfo]);

  /* ── Progress: post every ~10s while playing. ── */
  useEffect(() => {
    if (!playing) return undefined;
    const id = window.setInterval(postProgressNow, PROGRESS_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing, postProgressNow]);

  /* ── Auto-hide the chrome ~3.5s after the last input while playing; stay up
     while paused or while a menu is open. Any input bumps interactionTick,
     which restarts this timer. ── */
  useEffect(() => {
    setChromeVisible(true);
    if (!playing || openMenu) return undefined;
    const id = window.setTimeout(() => setChromeVisible(false), CHROME_HIDE_MS);
    return () => window.clearTimeout(id);
  }, [interactionTick, playing, openMenu]);

  /* ── Active segment under the playhead + the skip/auto-skip state. ── */
  const activeSegment = useMemo(() => {
    if (segments.length === 0) return null;
    const ms = current * 1000;
    return segments.find((s) => ms >= s.start_ms && ms < s.end_ms) ?? null;
  }, [segments, current]);

  const segKey = (s: Segment): string => `${s.kind}:${s.start_ms}`;

  // Seek past a segment (+0.25s so we land clear of the final segment frame —
  // web parity).
  const skipSegment = useCallback((seg: Segment) => {
    const p = playerRef.current;
    if (!p) return;
    const target = seg.end_ms / 1000 + 0.25;
    guardRef.current?.expectSeek(target);
    p.seek(target);
  }, []);

  /* ── Auto-skip countdown. Arms when the playhead enters an intro/credits
     segment whose auto-skip setting is on and that the user hasn't cancelled
     this session. Ticks down skipCountdownSec, then seeks past the segment.
     Any DPAD press cancels via dismissedSegRef (see the key handler). ── */
  useEffect(() => {
    const seg = activeSegment;
    if (!seg) {
      setSkipCountdown(null);
      return undefined;
    }
    const kind = seg.kind.toLowerCase();
    const wantAuto =
      (kind === 'intro' && settings.autoSkipIntro) ||
      (kind === 'recap' && settings.autoSkipIntro) ||
      (kind === 'credits' && settings.autoSkipCredits);
    if (!wantAuto || dismissedSegRef.current.has(segKey(seg))) {
      setSkipCountdown(null);
      return undefined;
    }
    setSkipCountdown(Math.max(1, settings.skipCountdownSec));
    const id = window.setInterval(() => {
      setSkipCountdown((n) => {
        if (n == null) return n;
        if (n <= 1) {
          window.clearInterval(id);
          // Claim the segment so re-entry (seek-back) doesn't re-arm it.
          dismissedSegRef.current.add(segKey(seg));
          skipSegment(seg);
          return null;
        }
        return n - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
    // Re-arm only when the segment instance changes — not on every tick (the
    // skipCountdown setState would otherwise cancel-and-restart the interval).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSegment ? segKey(activeSegment) : null,
    settings.autoSkipIntro,
    settings.autoSkipCredits,
    settings.skipCountdownSec,
  ]);

  /* ── Mark watched on credits entry OR at >=95% of the runtime, once per
     mount (web parity). ── */
  useEffect(() => {
    if (markedWatchedRef.current || !itemId) return;
    const inCredits = activeSegment?.kind.toLowerCase() === 'credits';
    const near95 =
      effectiveDuration > 0 && current / effectiveDuration >= WATCHED_THRESHOLD;
    if (!inCredits && !near95) return;
    markedWatchedRef.current = true;
    void api.setWatched(itemId).catch(() => undefined);
  }, [activeSegment, current, effectiveDuration, itemId]);

  /* ── End-of-media: auto-play the next episode (series + setting on), else
     pop back. Guarded so it fires once. ── */
  const handleEnded = useCallback(async () => {
    if (autoAdvancedRef.current) return;
    autoAdvancedRef.current = true;
    postProgressNow();
    const parentId = item?.parent_id;
    if (settings.autoPlayNext && item?.type === 'episode' && parentId) {
      const nextId = await fetchNextEpisodeId(parentId, itemId);
      if (nextId) {
        navigate(`/player/${encodeURIComponent(nextId)}`);
        return;
      }
    }
    back();
  }, [item, itemId, settings.autoPlayNext, postProgressNow]);

  /* ── Quality switch: re-load the master with the new ?q=, preserving the
     current position (web rebuilds hls with the new single-variant URL; we do
     the engine-level equivalent via load(..., { startSec })). ── */
  const changeQuality = useCallback((id: string) => {
    const p = playerRef.current;
    if (!p || id === qualityRef.current) return;
    setQuality(id);
    qualityRef.current = id;
    const pos = Math.floor(p.currentTime());
    const url = api.masterUrl(itemId, {
      streamToken: streamTokenRef.current,
      quality: id || undefined,
      caps: capsRef.current,
    });
    setBuffering(true);
    // The reload restarts at the head and seeks back to `pos`; until it gets
    // there the last played position stands.
    guardRef.current?.expectSeek(pos);
    void p.load(url, { startSec: pos > 0 ? pos : undefined });
  }, [itemId]);

  const togglePlay = useCallback(() => {
    playerRef.current?.togglePlay();
    noteInteraction();
  }, [noteInteraction]);

  const seekBy = useCallback((delta: number) => {
    const p = playerRef.current;
    if (!p) return;
    const dur = durationRef.current;
    const target = p.currentTime() + delta;
    const clamped = Math.max(0, dur > 0 ? Math.min(target, dur) : target);
    // `current` moves at once so the scrub bar follows the remote; the resume
    // position waits until playback reports it got there.
    guardRef.current?.expectSeek(clamped);
    p.seek(clamped);
    setCurrent(clamped);
  }, []);

  /* ── Remote keys. Registered via useRemoteKey so they fire before the focus
     engine's arrow navigation; preventDefault() stops the engine also acting on
     the key (e.g. so LEFT/RIGHT seek instead of moving focus when the chrome is
     hidden). Any registered key cancels a pending auto-skip and re-shows the
     chrome — matching both references' "any input wakes the controls". ── */
  useRemoteKey(
    [
      TVKey.ENTER,
      TVKey.MEDIA_PLAY_PAUSE,
      TVKey.MEDIA_PLAY,
      TVKey.MEDIA_PAUSE,
      TVKey.LEFT,
      TVKey.RIGHT,
      TVKey.UP,
      TVKey.MEDIA_FAST_FORWARD,
      TVKey.MEDIA_REWIND,
    ],
    (e) => {
      const code = e.keyCode || e.which;

      // Any remote press wakes the chrome (web + androidtv parity).
      noteInteraction();
      // Any DPAD press cancels a running auto-skip for the active segment (the
      // user opted to keep watching). Mirrors androidtv's BACK-cancels-skip /
      // chino-web's "Watch intro" dismiss, generalised to any nav key.
      if (skipCountdown != null && activeSegment) {
        dismissedSegRef.current.add(segKey(activeSegment));
        setSkipCountdown(null);
      }

      // While a menu is open, let the focus engine drive UP/DOWN/LEFT/RIGHT
      // within it and ENTER to select — don't hijack those here. Media keys
      // still act globally.
      const mediaKey =
        code === TVKey.MEDIA_FAST_FORWARD ||
        code === TVKey.MEDIA_REWIND ||
        code === TVKey.MEDIA_PLAY_PAUSE ||
        code === TVKey.MEDIA_PLAY ||
        code === TVKey.MEDIA_PAUSE;
      if (openMenu && !mediaKey) return;

      switch (code) {
        case TVKey.MEDIA_FAST_FORWARD:
          seekBy(FF_STEP_SEC);
          e.preventDefault();
          break;
        case TVKey.MEDIA_REWIND:
          seekBy(-FF_STEP_SEC);
          e.preventDefault();
          break;
        case TVKey.MEDIA_PLAY:
          playerRef.current?.play();
          e.preventDefault();
          break;
        case TVKey.MEDIA_PAUSE:
          playerRef.current?.pause();
          e.preventDefault();
          break;
        case TVKey.MEDIA_PLAY_PAUSE:
          togglePlay();
          e.preventDefault();
          break;
        case TVKey.UP:
          // Just reveal the chrome; let the focus engine handle focus moves
          // among the now-visible buttons on subsequent presses.
          if (!chromeVisible) e.preventDefault();
          break;
        case TVKey.ENTER:
          // ENTER toggles play ONLY when the chrome is hidden (web "click on
          // video"). With the chrome up, let the focused control consume it.
          if (!chromeVisible) {
            togglePlay();
            e.preventDefault();
          }
          break;
        case TVKey.LEFT:
          // Seek back when the chrome is hidden; otherwise the focus engine
          // navigates between control buttons.
          if (!chromeVisible) {
            seekBy(-SEEK_STEP_SEC);
            e.preventDefault();
          }
          break;
        case TVKey.RIGHT:
          if (!chromeVisible) {
            seekBy(SEEK_STEP_SEC);
            e.preventDefault();
          }
          break;
        default:
          break;
      }
    },
  );

  // BACK: close an open menu first; else stop, post final progress, and pop the
  // route. Consume so the focus engine / history pop don't also fire.
  useRemoteKey(TVKey.BACK, (e) => {
    e.preventDefault();
    if (openMenu) {
      setOpenMenu(null);
      noteInteraction();
      return;
    }
    playerRef.current?.pause();
    postProgressNow();
    back();
  });

  /* ──────────────────────────────  render  ─────────────────────────────── */

  if (error) {
    return <ErrorScreen message={error} />;
  }

  const showSpinner = loading || (!firstFrame && buffering);
  const episodeBadge =
    item?.season_number != null && item?.episode_number != null
      ? `S${String(item.season_number).padStart(2, '0')}E${String(item.episode_number).padStart(2, '0')}`
      : null;
  const qualities = playInfo?.qualities ?? [];
  // The text track on screen, if one is: PGS is the engine's to draw.
  const activeSub = subtitles.find((s) => s.id === activeSubId) ?? null;
  const activeTextUrl =
    activeSub && subtitleKind(activeSub.format) === 'text' ? activeSub.url : null;

  return (
    <div className="relative h-screen w-full overflow-hidden bg-black text-text">
      {/* The engine renders here (a <video> for hls, a native <object> for
          AVPlay). Fills the screen behind every overlay. */}
      <div ref={stageRef} className="absolute inset-0 h-full w-full bg-black" />

      {/* Text subtitles, drawn here on both engines (AVPlay draws none);
          raised above the control bar while it is up. */}
      <SubtitleOverlay url={activeTextUrl} time={current} lifted={chromeVisible} />

      {/* Loading / buffering overlay — Spinner per the contract. */}
      {showSpinner ? (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/40">
          <Spinner label={loading ? 'Preparing your title…' : 'Buffering…'} fullscreen={false} />
        </div>
      ) : null}

      {/* Auto-skip countdown card — replaces the plain skip button while the
          countdown runs (web replaces the button with the countdown the same
          way). Any DPAD press cancels it (see the key handler). */}
      {activeSegment && skipCountdown != null ? (
        <div className="absolute bottom-40 right-14 z-30 flex items-center gap-3 rounded-xl bg-surface/95 px-5 py-4 text-lg shadow-2xl ring-1 ring-border-2">
          <SkipForward className="h-5 w-5 text-accent" aria-hidden />
          <span className="text-white">
            Skipping {kindLabel(activeSegment.kind).toLowerCase()} in {skipCountdown}…
          </span>
          <span className="text-sm text-muted">Press any key to cancel</span>
        </div>
      ) : null}

      {/* Manual skip button — shown whenever the playhead sits in an
          intro/recap/credits segment and no auto-skip countdown is on screen.
          Focusable so the D-pad can reach it. */}
      {activeSegment && skipCountdown == null ? (
        <SkipButton
          segment={activeSegment}
          onSkip={() => {
            dismissedSegRef.current.add(segKey(activeSegment));
            skipSegment(activeSegment);
            noteInteraction();
          }}
        />
      ) : null}

      {/* Control overlay — bottom chrome (title, scrub bar, transport + menu
          buttons). Hidden by default while playing; any remote key re-shows it.
          pointer-events toggle so a hidden overlay can't trap clicks. */}
      <div
        className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black via-black/80 to-transparent px-14 pb-12 pt-28 transition-opacity duration-300"
        style={{ opacity: chromeVisible ? 1 : 0, pointerEvents: chromeVisible ? 'auto' : 'none' }}
      >
        {/* Title + episode badge. */}
        <div className="mb-5 flex items-center gap-4">
          {episodeBadge ? (
            <span className="rounded bg-white/10 px-2 py-1 text-base font-medium tracking-wide text-accent">
              {episodeBadge}
            </span>
          ) : null}
          <h1 className="truncate text-4xl font-bold text-white">{item?.title ?? 'Loading…'}</h1>
        </div>

        {/* Scrub / progress bar with trickplay preview. */}
        <ScrubBar
          current={current}
          duration={effectiveDuration}
          segments={segments}
          trickplayCues={trickplayCues}
          trickplayBase={
            streamTokenRef.current
              ? `${apiBase()}/v1/items/${encodeURIComponent(itemId)}/play/trickplay`
              : ''
          }
          streamToken={streamTokenRef.current}
        />

        {/* Transport + menu button row. */}
        <div className="mt-5 flex items-center gap-3">
          <ControlButton
            label="Back"
            onEnter={() => {
              playerRef.current?.pause();
              postProgressNow();
              back();
            }}
          >
            <ArrowLeft className="h-6 w-6" />
          </ControlButton>

          <ControlButton label="Rewind 10 seconds" onEnter={() => seekBy(-SEEK_STEP_SEC)}>
            <Rewind className="h-6 w-6" />
          </ControlButton>

          <ControlButton
            label={playing ? 'Pause' : 'Play'}
            autoFocus
            onEnter={togglePlay}
          >
            {playing ? (
              <Pause className="h-7 w-7 fill-current" />
            ) : (
              <Play className="h-7 w-7 fill-current" />
            )}
          </ControlButton>

          <ControlButton label="Forward 10 seconds" onEnter={() => seekBy(SEEK_STEP_SEC)}>
            <FastForward className="h-6 w-6" />
          </ControlButton>

          {/* Episode prev/next (series only) — best-effort resolve via the
              series next-episode endpoint; prev has no dedicated endpoint so
              we offer next only, matching what the shared API exposes. */}
          {item?.type === 'episode' && item.parent_id ? (
            <ControlButton
              label="Next episode"
              onEnter={() => {
                const parentId = item.parent_id;
                if (!parentId) return;
                void fetchNextEpisodeId(parentId, itemId).then((nextId) => {
                  if (nextId) {
                    postProgressNow();
                    navigate(`/player/${encodeURIComponent(nextId)}`);
                  }
                });
              }}
            >
              <ChevronRight className="h-6 w-6" />
            </ControlButton>
          ) : null}

          <div className="flex-1" />

          {/* Audio menu — only when there's a choice. */}
          {audioTracks.length > 1 ? (
            <ControlButton
              label="Audio track"
              active={openMenu === 'audio'}
              onEnter={() => setOpenMenu((m) => (m === 'audio' ? null : 'audio'))}
            >
              <AudioLines className="h-6 w-6" />
            </ControlButton>
          ) : null}

          {/* Subtitles menu — shown when the title has any subtitles. */}
          {subtitles.length > 0 ? (
            <ControlButton
              label="Subtitles"
              active={openMenu === 'subtitles' || activeSubId != null}
              onEnter={() => setOpenMenu((m) => (m === 'subtitles' ? null : 'subtitles'))}
            >
              <Captions className="h-6 w-6" />
            </ControlButton>
          ) : null}

          {/* Quality menu — only when the ladder has more than one rung. */}
          {qualities.length > 1 ? (
            <ControlButton
              label="Quality"
              active={openMenu === 'quality'}
              onEnter={() => setOpenMenu((m) => (m === 'quality' ? null : 'quality'))}
            >
              <Gauge className="h-6 w-6" />
            </ControlButton>
          ) : null}
        </div>
      </div>

      {/* D-pad menus — float above the control bar; the first row auto-focuses,
          ENTER selects, BACK closes (handled in the BACK key handler). At most
          one is open at a time. */}
      {openMenu === 'audio' ? (
        <DpadMenu
          title="Audio"
          rows={audioTracks.map((t) => ({ id: t.id, label: t.label, selected: false }))}
          onPick={(id) => {
            playerRef.current?.setAudioTrack(id);
            setOpenMenu(null);
            noteInteraction();
          }}
        />
      ) : null}

      {openMenu === 'subtitles' ? (
        <DpadMenu
          title="Subtitles"
          rows={[
            { id: '__off__', label: 'Off', selected: activeSubId == null },
            ...subtitles.map((t) => ({
              id: t.id,
              label: t.label,
              selected: t.id === activeSubId,
            })),
          ]}
          onPick={(id) => {
            const next = id === '__off__' ? null : id;
            // The engine draws PGS only; a text track (or off) clears it.
            const p = playerRef.current;
            if (p && 'setSubtitles' in p) p.setTextTrack(next);
            setActiveSubId(next);
            setOpenMenu(null);
            noteInteraction();
          }}
        />
      ) : null}

      {openMenu === 'quality' ? (
        <DpadMenu
          title="Quality"
          rows={qualities.map((q) => ({
            id: q.id,
            label: q.height ? `${q.label} · ${q.height}p` : q.label,
            selected: q.id === quality,
          }))}
          onPick={(id) => {
            changeQuality(id);
            setOpenMenu(null);
            noteInteraction();
          }}
        />
      ) : null}
    </div>
  );
}

/* ─────────────────────────────  sub-views  ─────────────────────────────── */

/** A focusable transport / menu button in the control bar. Inverts on focus;
 *  tinted accent when its menu is the open one (or captions are on). */
function ControlButton({
  label,
  onEnter,
  active,
  autoFocus,
  children,
}: {
  label: string;
  onEnter: () => void;
  active?: boolean;
  autoFocus?: boolean;
  children: JSX.Element;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus });
  return (
    <div
      ref={ref}
      data-focused={focused}
      title={label}
      aria-label={label}
      className={[
        'flex h-14 w-14 cursor-default select-none items-center justify-center rounded-full',
        focused
          ? 'bg-white text-black'
          : active
            ? 'bg-accent/25 text-accent'
            : 'bg-white/10 text-white',
      ].join(' ')}
    >
      {children}
    </div>
  );
}

/**
 * Scrub / progress bar. Renders the buffered/played fill, the segment stripes
 * (intro/credits/recap tick bands), the time labels, and — when trickplay cues
 * are present — a sprite-cropped thumbnail above the playhead. There's no mouse
 * on a TV, so the preview tracks the live playhead (the user scrubs with the
 * remote's seek keys, which move `current`); on a 404 the cue list is empty and
 * no preview renders, degrading to a plain bar.
 */
function ScrubBar({
  current,
  duration,
  segments,
  trickplayCues,
  trickplayBase,
  streamToken,
}: {
  current: number;
  duration: number;
  segments: Segment[];
  trickplayCues: TrickplayCue[];
  trickplayBase: string;
  streamToken: string;
}): JSX.Element {
  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const cue = trickplayCues.length > 0 ? findTrickplayCue(trickplayCues, current) : null;

  // Sprite URL with the stream token appended (the trickplay route is in the
  // stream-token group). The cue's sprite filename hangs off the trickplay base.
  const spriteUrl =
    cue && streamToken
      ? `${trickplayBase}/${cue.sprite}?stream=${encodeURIComponent(streamToken)}`
      : '';

  return (
    <div className="flex flex-col gap-2">
      {/* Trickplay preview — sprite-cropped tile pinned above the playhead. */}
      {cue && spriteUrl ? (
        <div
          className="relative mb-1 h-[var(--tph)] w-[var(--tpw)] -translate-x-1/2 overflow-hidden rounded-md ring-1 ring-border-2"
          style={
            {
              left: `${pct}%`,
              '--tpw': `${cue.w}px`,
              '--tph': `${cue.h}px`,
              backgroundImage: `url("${spriteUrl}")`,
              backgroundPosition: `-${cue.x}px -${cue.y}px`,
              backgroundRepeat: 'no-repeat',
            } as React.CSSProperties
          }
        />
      ) : null}

      {/* The bar itself. */}
      <div className="relative h-2 w-full rounded-full bg-white/20">
        {/* Segment stripes — coloured bands at intro/credits/recap ranges. */}
        {duration > 0
          ? segments.map((s) => {
              const left = Math.max(0, Math.min(100, (s.start_ms / 1000 / duration) * 100));
              const width = Math.max(
                0,
                Math.min(100 - left, ((s.end_ms - s.start_ms) / 1000 / duration) * 100),
              );
              const k = s.kind.toLowerCase();
              const color =
                k === 'credits' ? 'bg-signal-amber/70' : k === 'recap' ? 'bg-accent/50' : 'bg-accent/70';
              return (
                <div
                  key={`${s.kind}:${s.start_ms}`}
                  className={`absolute top-0 h-full ${color}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              );
            })
          : null}
        {/* Played fill. */}
        <div className="absolute left-0 top-0 h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        {/* Playhead knob. */}
        <div
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
          style={{ left: `${pct}%` }}
        />
      </div>

      {/* Time labels. */}
      <div className="flex items-center justify-between text-base text-muted">
        <span>{formatTime(current)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}

/** A focusable Skip-Intro / Skip-Credits / Skip-Recap button, bottom-right. */
function SkipButton({
  segment,
  onSkip,
}: {
  segment: Segment;
  onSkip: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter: onSkip });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={[
        'absolute bottom-40 right-14 z-30 inline-flex cursor-default select-none items-center gap-2 rounded-full px-6 py-3 text-lg font-semibold',
        focused ? 'bg-white text-black' : 'bg-white/15 text-white',
      ].join(' ')}
    >
      <SkipForward className="h-5 w-5" />
      Skip {kindLabel(segment.kind)}
    </div>
  );
}

/** A floating D-pad menu (Audio / Subtitles / Quality). Rows are focusable; the
 *  selected row carries a check + accent text. The first row auto-focuses so
 *  the D-pad lands somewhere sensible; ENTER picks; BACK closes (at call site).
 *  Mirrors chino-androidtv's MenuPopover / chino-web's menu cards. */
function DpadMenu({
  title,
  rows,
  onPick,
}: {
  title: string;
  rows: { id: string; label: string; selected: boolean }[];
  onPick: (id: string) => void;
}): JSX.Element {
  return (
    <div className="absolute bottom-32 right-14 z-40 w-80 overflow-hidden rounded-xl bg-surface/98 shadow-2xl ring-1 ring-border-2">
      <div className="border-b border-border px-5 py-3 text-sm font-medium uppercase tracking-wide text-muted">
        {title}
      </div>
      <div className="max-h-96 overflow-y-auto py-1">
        {rows.length === 0 ? (
          <div className="px-5 py-3 text-base text-muted">No tracks</div>
        ) : (
          rows.map((row, i) => (
            <MenuRow
              key={row.id}
              label={row.label}
              selected={row.selected}
              autoFocus={i === 0}
              onEnter={() => onPick(row.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function MenuRow({
  label,
  selected,
  autoFocus,
  onEnter,
}: {
  label: string;
  selected: boolean;
  autoFocus?: boolean;
  onEnter: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={[
        'flex cursor-default select-none items-center justify-between gap-3 px-5 py-3 text-lg',
        focused ? 'bg-white text-black' : selected ? 'text-accent' : 'text-white',
      ].join(' ')}
    >
      <span className="truncate">{label}</span>
      {selected ? <Check className="h-5 w-5 shrink-0" /> : null}
    </div>
  );
}

/** Terminal-error surface with a focusable Back affordance. */
function ErrorScreen({ message }: { message: string }): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter: () => back(), autoFocus: true });
  useRemoteKey(TVKey.BACK, (e) => {
    e.preventDefault();
    back();
  });
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-6 bg-black px-16 text-center">
      <Loader2 className="h-10 w-10 text-red" aria-hidden />
      <p className="text-2xl font-semibold text-white">Playback failed</p>
      <p className="max-w-2xl text-lg text-muted">{message}</p>
      <div
        ref={ref}
        data-focused={focused}
        className={[
          'inline-flex cursor-default select-none items-center gap-2 rounded-full px-6 py-3 text-xl font-semibold',
          focused ? 'bg-white text-black' : 'bg-white/15 text-white',
        ].join(' ')}
      >
        <ArrowLeft className="h-5 w-5" />
        Back
      </div>
    </div>
  );
}
