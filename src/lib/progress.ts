// The resume position: where playback starts, and what the player may write
// back. chino-api keeps ONE position per user and item (GET/POST
// /items/{id}/progress) and every client resumes from it, so a position written
// here overwrites what the viewer watched on the web or another TV. The player
// therefore only ever writes a second it actually played to in this session.
// Pure: progress.test.ts runs it under node --test.

/** A saved position at or below this is "not really started": play starts at
 *  the head. chino-api's continue-watching applies the same floor. */
export const RESUME_FLOOR_SEC = 30;

/** A saved position within this of the end is "finished" (chino-api's own
 *  finished test): play starts at the head instead of in the credits. */
export const FINISHED_MARGIN_SEC = 60;

/** How far short of an expected seek a reported playhead may land and still
 *  count as the seek having landed. Seeks snap back to a segment or key frame,
 *  a few seconds at most; the head of the stream, reported before a resume
 *  seek lands, is much further off. */
export const SEEK_LANDING_SLACK_SEC = 10;

export interface ResumeInput {
  /** The saved position from GET /items/{id}/progress, in seconds; null when
   *  it could not be read. */
  savedSec: number | null;
  /** The title's duration in seconds, 0 when unknown. */
  durationSec: number;
  /** ?startover=1 — the viewer asked to start from the head. */
  startover?: boolean;
  /** ?resume=<sec> — a hand-off from Zap, which played up to this second. */
  handoffSec?: number;
}

/**
 * Where playback starts, in whole seconds (0 = the head). chino-web's rules:
 * start over when asked; a Zap hand-off resumes exactly where the teaser was;
 * otherwise the saved position, unless it is barely started or finished.
 */
export function resumeStartSec(o: ResumeInput): number {
  if (o.startover) return 0;
  const handoff = o.handoffSec ?? 0;
  if (Number.isFinite(handoff) && handoff > 1) return Math.floor(handoff);
  const saved = o.savedSec ?? 0;
  if (!Number.isFinite(saved) || saved <= RESUME_FLOOR_SEC) return 0;
  if (o.durationSec > 0 && saved >= o.durationSec - FINISHED_MARGIN_SEC) return 0;
  return Math.floor(saved);
}

/**
 * Whether this session may write a position at all. When the saved position
 * could not be read, playback starts at the head without knowing what it would
 * overwrite, so nothing is written — unless the viewer chose where to start
 * (start over, or a Zap hand-off).
 */
export function mayWriteProgress(o: ResumeInput): boolean {
  if (o.startover) return true;
  if (Number.isFinite(o.handoffSec ?? 0) && (o.handoffSec ?? 0) > 1) return true;
  return o.savedSec != null;
}

/** What the player tells the guard, and asks it. */
export interface ProgressGuard {
  /** A seek to `sec` is under way that playback has not reached yet: the
   *  resume seek, a quality-switch reload, a skip or a remote seek. Positions
   *  reported well short of it are not where the viewer is. */
  expectSeek(sec: number): void;
  /** The engine reported the playhead at `sec` while playing. */
  played(sec: number): void;
  /** The position to write now, in whole seconds: one this session played
   *  to, or null when there is none (nothing played yet, or not writable). */
  position(): number | null;
}

/**
 * Track the last position playback actually reached. Nothing counts until the
 * engine reports a playing position; while a seek is pending, positions short
 * of its target (the head of the stream before a resume seek lands) are
 * ignored. A UI's optimistic playhead never reaches the guard.
 */
export function createProgressGuard(opts: { writable: boolean }): ProgressGuard {
  let expected: number | null = null;
  let last: number | null = null;
  return {
    expectSeek(sec) {
      expected = Number.isFinite(sec) && sec > 0 ? sec : null;
    },
    played(sec) {
      if (!Number.isFinite(sec) || sec <= 0) return;
      if (expected != null) {
        if (sec < expected - SEEK_LANDING_SLACK_SEC) return;
        expected = null;
      }
      last = sec;
    },
    position() {
      if (!opts.writable || last == null) return null;
      const pos = Math.floor(last);
      return pos > 0 ? pos : null;
    },
  };
}
