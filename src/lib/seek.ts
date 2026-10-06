// Where the remote's seeks start from. A seek starts from where the playhead
// is, but right after one an engine need not say so yet: AVPlay reports the
// playhead on its playback tick (oncurrentplaytime) and not at all while
// paused, so until its next tick it still reports where it was. Three quick
// presses of +10 s from 1:40 each started from 1:40 and landed at 1:50, and
// paused every press did. The player keeps the target of the seek in flight
// and starts the next one from it, until the engine reports the playhead near
// it - the seek landed - or a while after the seek, should the engine report
// it somewhere else: it landed elsewhere, or not at all. A playhead reported
// before the seek says nothing of it, so with no report since (AVPlay paused)
// the target stands. The hls.js engine reports a seek at once, so there a
// seek starts from its playhead as before. Pure: seek.test.ts runs it under
// node --test.

/** A playhead reported this close to the target: the seek landed. */
export const SEEK_LANDED_SEC = 1.5;

/** How long after the seek a target outlives reports that are not near it. */
export const SEEK_PENDING_MS = 3_000;

/** What the player tells the accumulator, and asks it. */
export interface SeekAccumulator {
  /** Where the playhead is, or is on its way to: the target of the seek in
   *  flight, else `reported`, the playhead the engine reports. */
  position(reported: number): number;
  /** A seek of `delta` seconds from position(reported), between the head and
   *  `duration` (0 = not known yet: no end). The target, in flight from now
   *  on. */
  seekBy(delta: number, reported: number, duration: number): number;
  /** A seek to `sec`, between the head and `duration`: a skip past a
   *  segment, the position a load resumes at. The target, in flight from now
   *  on. */
  seekTo(sec: number, duration: number): number;
  /** The engine reported the playhead at `sec`. */
  reported(sec: number): void;
}

/** Keep the seek in flight. `now` is the clock in milliseconds (a test
 *  passes its own). */
export function createSeekAccumulator(now: () => number = Date.now): SeekAccumulator {
  let target: number | null = null;
  // When the target was set, and whether the engine has reported since.
  let since = 0;
  let heard = false;

  const pending = (): number | null => {
    if (target != null && heard && now() - since >= SEEK_PENDING_MS) target = null;
    return target;
  };
  const aim = (sec: number, duration: number): number => {
    const s = Number.isFinite(sec) ? sec : 0;
    target = Math.max(0, Number.isFinite(duration) && duration > 0 ? Math.min(s, duration) : s);
    since = now();
    heard = false;
    return target;
  };

  return {
    position(reported) {
      return pending() ?? reported;
    },
    seekBy(delta, reported, duration) {
      return aim((pending() ?? reported) + delta, duration);
    },
    seekTo(sec, duration) {
      return aim(sec, duration);
    },
    reported(sec) {
      if (target == null || !Number.isFinite(sec)) return;
      if (Math.abs(sec - target) <= SEEK_LANDED_SEC) target = null;
      else heard = true;
    },
  };
}
