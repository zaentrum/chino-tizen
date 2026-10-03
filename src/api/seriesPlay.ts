// "Play" on a series: fetch what the choice needs and pick the episode
// (@/lib/seriesPlay) — the one in progress, else the next. Shared by the
// detail page and the Home hero; the series root itself has nothing to play.

import type { Item } from './types';
import { api } from './instance';
import { pickSeriesEpisode } from '@/lib/seriesPlay';
import { resumeStartSec } from '@/lib/progress';

export interface SeriesPlayTarget {
  episodeId: string;
  /** The episode, when known: its SxxEyy goes on the button. */
  episode?: Item;
  /** Where the player will resume it, by its own rules; 0 = from the head. */
  resumeSec: number;
}

/**
 * Resolve the episode "Play" starts for a series. `knownEpisodes` saves the
 * episode-list round trip when the caller already has it (the detail page).
 * Null when the series has nothing to play.
 */
export async function resolveSeriesPlay(
  seriesId: string,
  knownEpisodes?: readonly Item[],
): Promise<SeriesPlayTarget | null> {
  const [episodes, continueWatching, next] = await Promise.all([
    knownEpisodes && knownEpisodes.length > 0
      ? Promise.resolve(knownEpisodes)
      : api
          .seriesEpisodes(seriesId)
          .then((seasons) => seasons.reduce<Item[]>((all, s) => all.concat(s.episodes), []))
          .catch(() => [] as Item[]),
    api.continueWatching().catch(() => []),
    api.nextEpisode(seriesId).catch(() => null),
  ]);
  const pick = pickSeriesEpisode({ seriesId, episodes, continueWatching, next });
  if (!pick) return null;
  const episode =
    episodes.find((e) => e.id === pick.episodeId) ??
    continueWatching.find((r) => r.id === pick.episodeId) ??
    (next?.next && next.next.id === pick.episodeId ? next.next : undefined);
  // "Resume" only when the player will resume: the episode's own saved
  // position, by the player's floor and finished rules.
  const savedSec =
    pick.resumeSec > 0 ? pick.resumeSec : await api.getProgress(pick.episodeId).catch(() => 0);
  const resumeSec = resumeStartSec({ savedSec, durationSec: (episode?.duration_ms ?? 0) / 1000 });
  return { episodeId: pick.episodeId, episode, resumeSec };
}
