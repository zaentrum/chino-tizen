// A title's trailer, full screen, for the Tizen TV shell: /trailer/:itemId/
// :extraId, what a title's Trailer opens when the server plays one
// (@/lib/trailers). It plays on the player engine (@/player: AVPlay on a TV,
// falling back to hls.js) and nothing else of the player: from the head, with
// sound, and BACK, or the end, goes back. ENTER pauses and plays (so do the
// remote's play and pause keys), LEFT / RIGHT seek 10 s.
//
// A trailer is one of the title's extras: its own HLS master, play_path, asked
// for as a title's master is (?stream=, &caps=). It has no resume position, no
// watched state, no segments, no trickplay and no subtitles, and this screen
// asks for none of them — nor for a next episode or a prewarm: a trailer never
// shows up in Continue watching. (This client sends no telemetry.)
//
// A trailer that is not there — the title, an extra it does not list, or a
// master that answers 404 — says "Trailer not available", with the title's
// trailer online where it has one.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, RotateCw, Youtube } from 'lucide-react';
import type { ExtraRef, Item, Trailer } from '@/api/types';
import { api } from '@/api/instance';
import { createPlayer, detectCaps, type ChinoPlayer } from '@/player';
import {
  extraMasterUrl,
  findExtra,
  isNotFoundError,
  pickTrailer,
  seekTarget,
  trailerFailure,
} from '@/lib/trailers';
import { useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { back } from '@/router';
import { Spinner } from '@/components/Spinner';

/** LEFT / RIGHT seek step, as in the player. */
const SEEK_STEP_SEC = 10;

/** The title bar goes this long after the last key while playing. */
const CHROME_HIDE_MS = 3_500;

type Phase = 'loading' | 'playing' | 'not-found' | 'failed';

interface TrailerScreenProps {
  itemId: string;
  extraId: string;
}

export default function TrailerScreen({ itemId, extraId }: TrailerScreenProps): JSX.Element {
  // The surface the engine renders into (a <video> for hls, AVPlay's <object>).
  const stageRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<ChinoPlayer | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  // Bumped by Try again: a fresh engine on the same master.
  const [attempt, setAttempt] = useState(0);
  const [item, setItem] = useState<Item | null>(null);
  const [extra, setExtra] = useState<ExtraRef | null>(null);
  const [playing, setPlaying] = useState(false);
  const [firstFrame, setFirstFrame] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [keyTick, setKeyTick] = useState(0);
  // Gone back already: the end and a BACK can come together.
  const leftRef = useRef(false);

  const leave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    playerRef.current?.pause();
    back();
  }, []);

  /* ── Pure black around the stage while mounted, as in the player. ── */
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prev = { html: html.style.backgroundColor, body: body.style.backgroundColor, overflow: body.style.overflow };
    html.style.backgroundColor = '#000';
    body.style.backgroundColor = '#000';
    body.style.overflow = 'hidden';
    return () => {
      html.style.backgroundColor = prev.html;
      body.style.backgroundColor = prev.body;
      body.style.overflow = prev.overflow;
    };
  }, []);

  /* ── The title, the extra, its master; then the engine, from the head. ── */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    let cancelled = false;
    setPhase('loading');
    setPlaying(false);
    setFirstFrame(false);
    setCurrent(0);
    setDuration(0);

    const player = createPlayer(stage);
    playerRef.current = player;
    const offs = [
      player.on('ready', () => setDuration(player.duration())),
      player.on('playing', () => setPlaying(true)),
      player.on('paused', () => setPlaying(false)),
      player.on('firstframe', () => setFirstFrame(true)),
      player.on('timeupdate', () => {
        setCurrent(player.currentTime());
        const d = player.duration();
        if (d > 0) setDuration(d);
      }),
      player.on('ended', () => {
        if (!cancelled) leave();
      }),
      player.on('error', () => {
        if (!cancelled) setPhase('failed');
      }),
    ];

    void (async () => {
      try {
        const [loaded, token] = await Promise.all([api.getItem(itemId), api.streamToken()]);
        if (cancelled) return;
        setItem(loaded);
        const found = findExtra(loaded.extras, extraId);
        if (!found) {
          setPhase('not-found');
          return;
        }
        setExtra(found);
        const url = extraMasterUrl(api.assetUrl(found.play_path, token) ?? found.play_path, detectCaps());
        // AVPlay does not say why a master did not open: it is asked for once
        // first, so one that is not there says so. No answer at all leaves it
        // to the engine.
        const status = await fetch(url).then(
          (r) => r.status,
          () => null,
        );
        if (cancelled) return;
        if (status != null && status >= 400) {
          setPhase(trailerFailure(status));
          return;
        }
        setPhase('playing');
        await player.load(url);
        // From the head, with sound: AVPlay plays once it is prepared, the
        // hls.js engine when told.
        if (!cancelled) player.play();
      } catch (e) {
        if (!cancelled) setPhase(isNotFoundError(e) ? 'not-found' : 'failed');
      }
    })();

    return () => {
      cancelled = true;
      offs.forEach((off) => off());
      player.destroy();
      if (playerRef.current === player) playerRef.current = null;
    };
  }, [itemId, extraId, attempt, leave]);

  /* ── The title bar: up while paused, and for a moment after a key. ── */
  useEffect(() => {
    setChromeVisible(true);
    if (!playing) return undefined;
    const id = window.setTimeout(() => setChromeVisible(false), CHROME_HIDE_MS);
    return () => window.clearTimeout(id);
  }, [keyTick, playing]);

  /* ── Remote keys while it plays. Otherwise ENTER and the arrows are the
     focus engine's: the buttons of the message. ── */
  useRemoteKey(
    [TVKey.ENTER, TVKey.LEFT, TVKey.RIGHT, TVKey.MEDIA_PLAY_PAUSE, TVKey.MEDIA_PLAY, TVKey.MEDIA_PAUSE],
    (e) => {
      const p = playerRef.current;
      if (phase !== 'playing' || !p) return;
      const code = e.keyCode || e.which;
      setKeyTick((n) => n + 1);
      switch (code) {
        case TVKey.ENTER:
        case TVKey.MEDIA_PLAY_PAUSE:
          p.togglePlay();
          break;
        case TVKey.MEDIA_PLAY:
          p.play();
          break;
        case TVKey.MEDIA_PAUSE:
          p.pause();
          break;
        case TVKey.LEFT:
        case TVKey.RIGHT: {
          const to = seekTarget(p.currentTime(), code === TVKey.LEFT ? -SEEK_STEP_SEC : SEEK_STEP_SEC, p.duration());
          p.seek(to);
          setCurrent(to);
          break;
        }
        default:
          return;
      }
      e.preventDefault();
    },
  );

  useRemoteKey(TVKey.BACK, (e) => {
    e.preventDefault();
    leave();
  });

  /* ──────────────────────────────  render  ─────────────────────────────── */

  const online = item ? pickTrailer(item.trailers) : null;
  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const showSpinner = phase === 'loading' || (phase === 'playing' && !firstFrame);

  return (
    <div className="relative h-screen w-full overflow-hidden bg-black text-text">
      <div ref={stageRef} className="absolute inset-0 h-full w-full bg-black" />

      {showSpinner ? (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/40">
          <Spinner label="Preparing the trailer…" fullscreen={false} />
        </div>
      ) : null}

      {phase === 'playing' ? (
        <div
          className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black via-black/80 to-transparent px-14 pb-12 pt-28 transition-opacity duration-300"
          style={{ opacity: chromeVisible ? 1 : 0 }}
        >
          <div className="mb-5 flex items-center gap-4">
            {extra?.title ? (
              <span className="rounded bg-white/10 px-2 py-1 text-base font-medium tracking-wide text-accent">
                {extra.title}
              </span>
            ) : null}
            <h1 className="truncate text-4xl font-bold text-white">{item?.title ?? ''}</h1>
          </div>
          <div className="relative h-2 w-full rounded-full bg-white/20">
            <div className="absolute left-0 top-0 h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 flex items-center justify-between text-base text-muted">
            <span>{formatTime(current)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      ) : null}

      {phase === 'not-found' ? (
        <TrailerMessage
          title="Trailer not available"
          message="The server doesn't have this trailer. It may have been removed."
          online={online}
          onBack={leave}
        />
      ) : null}
      {phase === 'failed' ? (
        <TrailerMessage
          title="Couldn't play the trailer"
          message="Check the connection, or try again in a moment."
          online={online}
          onBack={leave}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : null}
    </div>
  );
}

/** "1:23" (m:ss); a trailer has no hours. */
function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What became of a trailer that does not play, over the stage: Back, Try
 *  again where it can help, and the title's trailer online where it has one —
 *  handed to the platform as the detail screen does. */
function TrailerMessage({
  title,
  message,
  online,
  onBack,
  onRetry,
}: {
  title: string;
  message: string;
  online: Trailer | null;
  onBack: () => void;
  onRetry?: () => void;
}): JSX.Element {
  const youtube = (online?.site ?? '').toLowerCase().includes('youtube');
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-black px-16 text-center">
      <p className="text-3xl font-semibold text-white">{title}</p>
      <p className="max-w-2xl text-lg text-muted">{message}</p>
      <div className="mt-2 flex items-center gap-4">
        <MessageButton label="Back" icon={<ArrowLeft className="h-5 w-5" />} onEnter={onBack} autoFocus />
        {onRetry ? <MessageButton label="Try again" icon={<RotateCw className="h-5 w-5" />} onEnter={onRetry} /> : null}
        {online?.url ? (
          <MessageButton
            label={youtube ? 'Watch on YouTube' : 'Watch online'}
            icon={<Youtube className="h-5 w-5" />}
            onEnter={() => {
              // No in-app browser on Tizen: hand the URL to the platform.
              try {
                window.open(online.url, '_blank');
              } catch {
                /* sandboxed — ignore */
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function MessageButton({
  label,
  icon,
  onEnter,
  autoFocus,
}: {
  label: string;
  icon: JSX.Element;
  onEnter: () => void;
  autoFocus?: boolean;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={[
        'inline-flex cursor-default select-none items-center gap-2 rounded-full px-6 py-3 text-xl font-semibold',
        focused ? 'bg-white text-black' : 'bg-white/15 text-white',
      ].join(' ')}
    >
      {icon}
      {label}
    </div>
  );
}
