// Which episode "Play" on a series starts: the one the viewer is in the
// middle of, else the next one — never simply the first. The sources are the
// ones chino-web reads: the continue-watching feed (newest first, with each
// episode's saved position; a finished episode shows up as the server's
// next-up card for the episode after it), and /series/{id}/next-episode, which
// knows the series' last-touched episode beyond the feed's twenty newest rows.
// Pure: seriesPlay.test.ts runs it under node --test.

import { FINISHED_MARGIN_SEC, RESUME_FLOOR_SEC } from './progress.ts';

/** An episode of the series, as /series/{id}/episodes lists it. */
export interface SeriesEpisode {
  id: string;
  season_number?: number;
  /** Set when the viewer finished it (or marked it watched). */
  watched_at?: string | null;
}

/** A continue-watching row (/me/continue-watching). */
export interface ProgressRow {
  id: string;
  parent_id?: string;
  position_sec: number;
  duration_sec: number;
  up_next?: boolean;
}

/** /series/{id}/next-episode without ?after=: `anchor` is the series' episode
 *  the viewer touched last, `next` the one after it (the first episode when
 *  they never watched any; null at the end of the series). */
export interface NextEpisodeAnswer {
  next?: { id: string } | null;
  anchor?: string;
}

export interface SeriesPlay {
  episodeId: string;
  /** The saved position the player will resume from; 0 = not known here (the
   *  player reads the episode's own position either way). */
  resumeSec: number;
}

/** chino-web's resume-row test (DetailPage): a row the viewer is in the middle
 *  of — not a next-up card, more than barely started, not finished. */
export function isInProgress(row: ProgressRow): boolean {
  if (row.up_next || !(row.position_sec > RESUME_FLOOR_SEC)) return false;
  return row.duration_sec <= 0 || row.position_sec < row.duration_sec - FINISHED_MARGIN_SEC;
}

/**
 * The episode to play, in this order:
 *  1. the series' newest continue-watching row: the episode in progress
 *     (resumed), or the next-up card the server put there for a finished one;
 *  2. the server's last-touched episode while it is unfinished, else the
 *     first unwatched one from its successor on;
 *  3. the first unwatched episode — of the regular seasons when there are
 *     any (specials sort first, as season 0) — and the first one again when
 *     the viewer has seen them all.
 */
export function pickSeriesEpisode(o: {
  seriesId: string;
  /** The series' episodes in order, season by season. */
  episodes: readonly SeriesEpisode[];
  continueWatching: readonly ProgressRow[];
  next: NextEpisodeAnswer | null;
}): SeriesPlay | null {
  const play = (episodeId: string, resumeSec = 0): SeriesPlay => ({ episodeId, resumeSec });

  const row = o.continueWatching.find((r) => r.parent_id === o.seriesId);
  if (row && isInProgress(row)) return play(row.id, row.position_sec);
  if (row && row.up_next) return play(row.id);

  const watched = new Set(o.episodes.filter((e) => e.watched_at != null).map((e) => e.id));
  const anchor = o.next?.anchor;
  if (anchor) {
    if (!watched.has(anchor) && o.episodes.some((e) => e.id === anchor)) return play(anchor);
    const nextId = o.next?.next?.id;
    if (nextId) {
      const from = o.episodes.findIndex((e) => e.id === nextId);
      // Not in the list we have (it did not load): the server's word stands.
      if (from < 0) return play(nextId);
      const fresh = o.episodes.slice(from).find((e) => !watched.has(e.id));
      if (fresh) return play(fresh.id);
    }
  }

  const regular = o.episodes.filter((e) => (e.season_number ?? 0) > 0);
  const inOrder = regular.length > 0 ? regular : o.episodes;
  const pick = inOrder.find((e) => !watched.has(e.id)) ?? inOrder[0];
  if (pick) return play(pick.id);
  const serverNext = o.next?.next?.id;
  return serverNext ? play(serverNext) : null;
}
