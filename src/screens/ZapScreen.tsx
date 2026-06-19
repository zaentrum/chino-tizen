// Full-screen channel-surf ("Zap") — TV only. A single reused player streams a
// random scene of each card WITH SOUND (channel-surf, not a silent teaser);
// DPAD-DOWN or CH+ flips to the next channel (and hides the info overlay), CH-
// goes back a channel (history-backed, same scene), DPAD-UP brings the info
// overlay back, DPAD-LEFT toggles mute, ENTER/CENTER expands into the real
// player at the current scene, DPAD-RIGHT saves the channel to the watchlist,
// BACK returns home. The info overlay auto-fades after ~60 s.
//
// Faithful port of chino-androidtv ui/zap/ZapScreen.kt (the reused single
// player, channel history + cursor, cold-start backdrop until first frame,
// bounded dead-channel auto-skip, info-overlay linger) and chino-web's
// ZapCard/useZapMidpoint (client-side mid-scene seek — never a server `?t=`,
// which packaged CMAF items silently ignore).
//
// Surfing must NOT touch progress / watched / continue-watching — only an OK
// "Watch from here" expand promotes a channel into the real player at the
// playhead the teaser reached.

import { useEffect, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, Volume2, VolumeX } from 'lucide-react';
import { api } from '@/api/instance';
import type { Item } from '@/api/types';
import { createPlayer, detectCaps, type ChinoPlayer } from '@/player';
import { useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { back, navigate } from '@/router';

/* ─────────────────────────────  Tunables  ──────────────────────────────── */

/** How long the channel-info overlay lingers before fading (old-TV info-bar
 *  feel). Mirrors androidtv OVERLAY_LINGER_MS. */
const OVERLAY_LINGER_MS = 60_000;

/** Auto-skip unplayable channels (e.g. a 404 master.m3u8 / no packaged asset),
 *  but stop after this many in a row so a bad pool can't spin forever. Mirrors
 *  androidtv MAX_DEAD_CHANNELS_IN_A_ROW. */
const MAX_DEAD_CHANNELS_IN_A_ROW = 6;

/** Caps we advertise to the preview pipeline. We probe real device caps via
 *  detectCaps() (canPlayType on web, conservative on-device), but the server
 *  still gates real codec selection on the source codecs. */
const TEASER_QUALITY = 'medium';

/* ───────────────────  Mid-scene midpoint (pure, ported)  ─────────────────── */
// Faithful port of chino-web useZapMidpoint.pickZapMidpoint / androidtv
// ZapMidpoint.kt. The seek is applied CLIENT-SIDE (player.load startSec), never
// via a server `?t=` — packaged items would ignore it and start at source-time
// 0 (the opening logo).

const MIN_SEEK_SEC = 60;
const TAIL_BUFFER_SEC = 90;
const DEFAULT_RATIO = 0.4;
const RAND_LOW = 0.1;
const RAND_HIGH = 0.8;

type MidpointSource = 'segments' | 'percent' | 'fallback';

/** Squeeze a [0,1] roll into [0.10,0.80] so zaps stay out of the opening minute
 *  and the closing-credits zone. undefined → the deterministic 0.40 fallback. */
function ratioFromRandom(r: number | undefined): number {
  if (r === undefined) return DEFAULT_RATIO;
  const c = Math.min(1, Math.max(0, r));
  return RAND_LOW + c * (RAND_HIGH - RAND_LOW);
}

/** Pick a mid-content seek point from the item duration. We don't fetch
 *  analyzer segments here (the androidtv Zap path also seeds from duration +
 *  percent only — segment-aware refinement is a non-gating upgrade that didn't
 *  move the seek for the packaged items that make up most of the pool), so this
 *  is the percent/fallback branch of the shared heuristic. FALLBACK means "too
 *  short to land mid-scene — start at 0 / skip". */
function pickZapMidpoint(
  durationMs: number | undefined,
  randomRatio: number | undefined,
): { seekSec: number; source: MidpointSource } {
  const ratio = ratioFromRandom(randomRatio);
  const durationSec = Math.floor((durationMs ?? 0) / 1000);

  if (durationSec <= MIN_SEEK_SEC + TAIL_BUFFER_SEC) {
    const s = Math.max(0, Math.min(Math.floor(durationSec / 2), MIN_SEEK_SEC));
    return { seekSec: s, source: 'fallback' };
  }

  const lower = MIN_SEEK_SEC;
  const upper = durationSec - TAIL_BUFFER_SEC;
  const clamp = (v: number): number => Math.min(Math.max(v, lower), upper);
  return { seekSec: clamp(Math.round(durationSec * ratio)), source: 'percent' };
}

/* ───────────────────────────  Channel history  ──────────────────────────── */

/** One card in the channel-surf history. `randomRatio` is rolled once per card
 *  so revisiting (CH-) keeps the same scene. */
interface ZapEntry {
  item: Item;
  randomRatio: number;
  seekSec: number;
}

/** Mute helper. The ChinoPlayer surface is intentionally transport-only (no
 *  volume control), so we toggle mute at the layer each engine actually owns:
 *  the <video> the hls engine renders into our container (off-device + the
 *  on-device hls fallback), and the system audio control on a Tizen panel
 *  (AVPlay plays through system audio, with no per-stream volume in the API we
 *  bind). Both guarded so an absent surface is a silent no-op. */
function applyMute(container: HTMLElement | null, muted: boolean): void {
  const video = container?.querySelector('video');
  if (video) {
    (video as HTMLVideoElement).muted = muted;
    (video as HTMLVideoElement).volume = muted ? 0 : 1;
  }
  // Tizen system audio (AVPlay path). Typed loosely — the global is ambient.
  const audio = (window.tizen as unknown as {
    tvaudiocontrol?: { setMute?: (m: boolean) => void };
  })?.tvaudiocontrol;
  try {
    audio?.setMute?.(muted);
  } catch {
    /* not supported on this model — ignore */
  }
}

/* ──────────────────────────────  Screen  ───────────────────────────────── */

export default function ZapScreen(): JSX.Element {
  // The full-screen container the reused player renders into.
  const stageRef = useRef<HTMLDivElement | null>(null);
  // One long-lived player reused across every channel — swapping the source
  // (load(), NOT recreate) avoids decoder churn while surfing.
  const playerRef = useRef<ChinoPlayer | null>(null);

  // Channel history + cursor. CH- replays a visited card (same scene); DOWN/CH+
  // advances within history, then pops the next feed item when at the head.
  const feedRef = useRef<Item[]>([]); // remaining (not-yet-shown) candidates
  const historyRef = useRef<ZapEntry[]>([]);
  const cursorRef = useRef(-1);
  // Bounded dead-channel guard so a run of unplayable items can't loop forever.
  const deadCountRef = useRef(0);
  // Stream token (minted once) used in every master/artwork URL.
  const tokenRef = useRef('');
  const capsRef = useRef('');

  const [phase, setPhase] = useState<'loading' | 'empty' | 'active'>('loading');
  const [active, setActive] = useState<ZapEntry | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [muted, setMuted] = useState(false);
  // Cold-start artwork gate: the item's backdrop fills the screen UNDER the
  // player until the decoder renders its first frame. Reset on every channel
  // change so the next channel shows its own backdrop while it spins up.
  const [firstFrame, setFirstFrame] = useState(false);
  const [saved, setSaved] = useState(false);

  // ── Build the master URL for an item at its rolled mid-scene seek. ──
  const masterUrlFor = (item: Item): string =>
    api.masterUrl(item.id, {
      streamToken: tokenRef.current,
      quality: TEASER_QUALITY,
      caps: capsRef.current,
    });

  // ── Promote a history entry to the active channel: swap the player source
  // (reuse, never recreate) and emit the cold-start artwork. ──
  const showEntry = (entry: ZapEntry): void => {
    setActive(entry);
    setFirstFrame(false);
    setPhase('active');
    void refreshSaved(entry.item.id);
    const player = playerRef.current;
    if (!player) return;
    const url = masterUrlFor(entry.item);
    // load() seeks to startSec once the engine is ready — the client-side seek
    // that makes packaged items land mid-scene (server `?t=` is ignored there).
    void player.load(url, { startSec: entry.seekSec > 0 ? entry.seekSec : undefined });
    applyMute(stageRef.current, muted);
  };

  // ── Advance to the next not-yet-shown candidate (DOWN / CH+ at the head). ──
  const advanceToNext = (): void => {
    const next = feedRef.current.shift();
    if (!next) {
      if (historyRef.current.length === 0) setPhase('empty');
      return;
    }
    const ratio = Math.random();
    const mid = pickZapMidpoint(next.duration_ms, ratio);
    const entry: ZapEntry = { item: next, randomRatio: ratio, seekSec: mid.seekSec };
    historyRef.current.push(entry);
    cursorRef.current = historyRef.current.length - 1;
    showEntry(entry);
  };

  const zapNext = (): void => {
    if (phase !== 'active') return;
    setOverlayVisible(false);
    const history = historyRef.current;
    if (cursorRef.current < history.length - 1) {
      cursorRef.current += 1;
      showEntry(history[cursorRef.current]);
    } else {
      advanceToNext();
    }
  };

  const zapPrev = (): void => {
    if (phase !== 'active' || cursorRef.current <= 0) return;
    setOverlayVisible(false);
    cursorRef.current -= 1;
    showEntry(historyRef.current[cursorRef.current]);
  };

  // ── OK / CENTER → hand off to the full player at the current playhead (the
  // scene the teaser reached, or the rolled seek if it never advanced). ──
  const expand = (): void => {
    const entry = active;
    if (!entry) return;
    const pos = playerRef.current?.currentTime() ?? 0;
    const resumeSec = pos > 0 ? Math.floor(pos) : entry.seekSec;
    navigate(`/player/${encodeURIComponent(entry.item.id)}?resume=${resumeSec}`);
  };

  // ── Save / unsave the current channel to the default watchlist (web + mobile
  // parity). Optimistic; reconciled by the server. ──
  const refreshSaved = async (itemId: string): Promise<void> => {
    try {
      const lists = await api.listWatchlists();
      const def = lists.find((l) => l.is_default) ?? lists[0];
      if (!def) {
        setSaved(false);
        return;
      }
      const { items } = await api.getWatchlist(def.id);
      setSaved(items.some((it) => it.id === itemId));
    } catch {
      setSaved(false);
    }
  };

  const toggleSave = (): void => {
    const entry = active;
    if (!entry) return;
    setOverlayVisible(true);
    const next = !saved;
    setSaved(next); // optimistic
    void (async () => {
      try {
        const lists = await api.listWatchlists();
        const def = lists.find((l) => l.is_default) ?? lists[0];
        if (!def) return;
        if (next) await api.addToWatchlist(def.id, entry.item.id);
        else await api.removeFromWatchlist(def.id, entry.item.id);
      } catch {
        setSaved(!next); // revert on failure
      }
    })();
  };

  /* ── Boot: create the single player, mint the stream token, load the feed. ─ */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    capsRef.current = detectCaps();
    const player = createPlayer(stage);
    playerRef.current = player;

    // First decoded frame → drop the cold-start backdrop so live video shows
    // through. Reset the dead-channel guard on any successful first frame.
    const offFrame = player.on('firstframe', () => {
      setFirstFrame(true);
      deadCountRef.current = 0;
    });
    const offPlaying = player.on('playing', () => {
      deadCountRef.current = 0;
    });
    // Dead channel (404 master / no playable asset) → auto-skip to the next,
    // bounded so an unplayable run can't loop forever.
    const offError = player.on('error', () => {
      if (deadCountRef.current < MAX_DEAD_CHANNELS_IN_A_ROW) {
        deadCountRef.current += 1;
        setOverlayVisible(false);
        zapNext();
      }
    });

    let cancelled = false;
    void (async () => {
      try {
        // Stream token first (media URLs carry `?stream=`, not the bearer).
        tokenRef.current = await api.streamToken().catch(() => '');
        const pool = await api.zapFeed(30);
        if (cancelled) return;
        feedRef.current = pool;
        if (pool.length === 0) {
          setPhase('empty');
          return;
        }
        advanceToNext();
      } catch {
        if (!cancelled) setPhase('empty');
      }
    })();

    return () => {
      cancelled = true;
      offFrame();
      offPlaying();
      offError();
      player.destroy();
      playerRef.current = null;
    };
    // Run once on mount — the player + feed are reused across channel changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Info overlay: shown on land + on UP, hidden on channel-change, and
     auto-faded after OVERLAY_LINGER_MS while visible. ── */
  useEffect(() => {
    if (!overlayVisible) return undefined;
    const t = window.setTimeout(() => setOverlayVisible(false), OVERLAY_LINGER_MS);
    return () => window.clearTimeout(t);
  }, [overlayVisible, active]);

  /* ── Apply mute toggles live (LEFT) without restarting the channel. ── */
  useEffect(() => {
    applyMute(stageRef.current, muted);
  }, [muted]);

  /* ── Remote keys. Registered via useRemoteKey so they fire before the focus
     engine's arrow navigation; preventDefault() stops the engine also acting on
     the arrows (there are no focusables on this surface anyway). ── */
  useRemoteKey(
    [
      TVKey.DOWN,
      TVKey.CHANNEL_UP,
      TVKey.CHANNEL_DOWN,
      TVKey.UP,
      TVKey.LEFT,
      TVKey.RIGHT,
      TVKey.ENTER,
    ],
    (e) => {
      switch (e.keyCode || e.which) {
        // Next channel — DPAD-down (doom-scroll) or CH+.
        case TVKey.DOWN:
        case TVKey.CHANNEL_UP:
          zapNext();
          break;
        // Previous channel — CH- (history-backed, same scene).
        case TVKey.CHANNEL_DOWN:
          zapPrev();
          break;
        // Bring the info overlay back.
        case TVKey.UP:
          setOverlayVisible(true);
          break;
        // Toggle sound — surf plays with audio by default.
        case TVKey.LEFT:
          setMuted((m) => !m);
          break;
        // Save the current channel (RIGHT is otherwise unused on this surface).
        case TVKey.RIGHT:
          toggleSave();
          break;
        // OK / CENTER — expand into the real player at the current scene.
        case TVKey.ENTER:
          expand();
          break;
        default:
          return;
      }
      e.preventDefault();
    },
  );

  // BACK → home (consume so the focus engine / history pop doesn't fire too).
  useRemoteKey(TVKey.BACK, (e) => {
    e.preventDefault();
    back();
  });

  /* ── Render ── */
  const item = active?.item;
  // Cold-start artwork: backdrop preferred, poster fallback (portrait items).
  const artwork =
    item && (item.backdrop_url || item.poster_url)
      ? api.posterUrl(item, tokenRef.current || undefined)
      : '';

  return (
    <div className="relative h-screen w-full overflow-hidden bg-black text-text">
      {/* The reused player renders into this stage (a <video> for hls, a native
          <object> for AVPlay). */}
      <div ref={stageRef} className="absolute inset-0 h-full w-full bg-black" />

      {phase === 'loading' ? <ZapMessage text="Tuning in…" /> : null}
      {phase === 'empty' ? (
        <ZapMessage text="Nothing left to zap. Come back later." />
      ) : null}

      {phase === 'active' && item ? (
        <>
          {/* Cold-start backdrop: full-screen artwork layered OVER the player
              (hiding the not-yet-rendered black surface) until the first frame
              fires. Crossfades out so the cut to live video isn't jarring. */}
          <div
            className="pointer-events-none absolute inset-0 bg-gradient-to-br from-surface via-bg to-black transition-opacity duration-500"
            style={{ opacity: firstFrame ? 0 : 1 }}
          >
            {artwork ? (
              <img
                src={artwork}
                alt=""
                className="h-full w-full object-cover"
                onError={(ev) => {
                  // Backdrop 404 → fall back to the gradient (poster already
                  // tried via posterUrl). Hide the broken image.
                  (ev.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : null}
          </div>

          {/* Cold-start hint so the user knows tuning is happening. */}
          {!firstFrame ? (
            <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 animate-pulse text-sm tracking-widest text-muted">
              TUNING…
            </div>
          ) : null}

          {/* Channel-info overlay — bottom gradient bar, auto-fades. */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black via-black/80 to-transparent px-14 pb-14 pt-24 transition-opacity duration-300"
            style={{ opacity: overlayVisible ? 1 : 0 }}
          >
            <ChannelInfo item={item} muted={muted} saved={saved} />
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ─────────────────────────  Overlay sub-views  ──────────────────────────── */

function ChannelInfo({
  item,
  muted,
  saved,
}: {
  item: Item;
  muted: boolean;
  saved: boolean;
}): JSX.Element {
  const episodeBadge =
    item.season_number != null && item.episode_number != null
      ? `S${String(item.season_number).padStart(2, '0')}E${String(
          item.episode_number,
        ).padStart(2, '0')}`
      : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <h1 className="truncate text-5xl font-bold text-white">{item.title}</h1>
        <SaveChip saved={saved} />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xl">
        {episodeBadge ? (
          <span className="font-medium tracking-wide text-accent">{episodeBadge}</span>
        ) : null}
        {item.year != null ? <span className="text-text">{item.year}</span> : null}
        {item.rating != null ? (
          <span className="text-accent">{`★ ${Number(item.rating).toFixed(1)}`}</span>
        ) : null}
        {item.genres && item.genres.length > 0 ? (
          <span className="text-muted">{item.genres.slice(0, 3).join(' · ')}</span>
        ) : null}
      </div>
      {item.description ? (
        <p className="line-clamp-3 max-w-3xl text-lg text-text">{item.description}</p>
      ) : null}
      <div className="mt-1 flex items-center gap-2 text-base text-muted">
        {muted ? (
          <VolumeX className="h-5 w-5" aria-hidden />
        ) : (
          <Volume2 className="h-5 w-5" aria-hidden />
        )}
        <span>
          {'OK Watch from here     ▼ / CH+ Next     CH- Back     ▲ Info     ◀ '}
          {muted ? 'Unmute' : 'Mute'}
          {'     ▶ '}
          {saved ? 'Saved' : 'Save'}
        </span>
      </div>
    </div>
  );
}

/** Save-state pill — Bookmark when unsaved, BookmarkCheck (emerald) when in the
 *  watchlist. RIGHT toggles it (see the root key handler); this just reflects
 *  the current membership. Mirrors web/mobile's Zap save affordance. */
function SaveChip({ saved }: { saved: boolean }): JSX.Element {
  return (
    <span
      className={[
        'inline-flex items-center gap-2 rounded-full px-4 py-2 text-base font-medium',
        saved ? 'bg-signal-green/20 text-signal-green' : 'bg-white/10 text-white',
      ].join(' ')}
    >
      {saved ? (
        <BookmarkCheck className="h-5 w-5" aria-hidden />
      ) : (
        <Bookmark className="h-5 w-5" aria-hidden />
      )}
      {saved ? 'Saved' : 'Save'}
    </span>
  );
}

function ZapMessage({ text }: { text: string }): JSX.Element {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black">
      <p className="text-2xl font-semibold text-white">{text}</p>
    </div>
  );
}
