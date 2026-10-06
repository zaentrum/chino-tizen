// What a title's Trailer plays. A trailer this server plays — one of the
// title's extras, chino-api's `extras` — comes first: it plays in the player
// (@/screens/PlayerScreen), in its extra mode (@/lib/playMode). Else a link
// to a trailer online (`trailers`), handed to the platform as before; else
// the title has no Trailer. The rules are chino-web's (src/lib/trailers.ts),
// so every client plays the same one. Pure: trailers.test.ts runs it under
// node --test.

import type { ExtraRef, Trailer } from '../api/types';

/** The kinds of extra that are a title's trailer, a trailer before a teaser. */
export const TRAILER_KINDS: readonly string[] = ['trailer', 'teaser'];

/** An extra the player can play: one this server has (an id,
 *  `local: true`), with a master (`play_path`). */
function playsHere(e: ExtraRef | null | undefined): e is ExtraRef {
  return (
    !!e &&
    e.local === true &&
    typeof e.id === 'string' &&
    e.id !== '' &&
    typeof e.play_path === 'string' &&
    e.play_path !== ''
  );
}

/**
 * The extra a title's Trailer plays: one of TRAILER_KINDS this server plays.
 * A trailer before a teaser, whatever their seasons — a season's trailer
 * before the whole title's teaser; within a kind, one of the whole title
 * before one of a season; and among equals the first in the server's order,
 * the order a viewer sees the extras in. Null when there is none.
 */
export function localTrailer(extras: readonly ExtraRef[] | null | undefined): ExtraRef | null {
  let pick: ExtraRef | null = null;
  let pickRank = Infinity;
  for (const e of extras ?? []) {
    if (!playsHere(e)) continue;
    const kind = TRAILER_KINDS.indexOf((e.kind ?? '').toLowerCase());
    if (kind < 0) continue;
    const rank = kind * 2 + (e.season_number == null ? 0 : 1);
    if (rank < pickRank) {
      pick = e;
      pickRank = rank;
    }
  }
  return pick;
}

/** The extra `extraId` of a title, when this server plays it: what the
 *  player plays in its extra mode. Any kind — it plays what it is sent to. */
export function findExtra(
  extras: readonly ExtraRef[] | null | undefined,
  extraId: string,
): ExtraRef | null {
  return (extras ?? []).find((e) => playsHere(e) && e.id === extraId) ?? null;
}

/**
 * The link the Trailer opened before the server played trailers, and still
 * does where it plays none: a YouTube one first, an "Official Trailer"
 * before any other trailer, else the first. Null when there is none.
 */
export function pickTrailer(trailers: readonly Trailer[] | null | undefined): Trailer | null {
  if (!trailers || trailers.length === 0) return null;
  const yt = trailers.filter((t) => (t.site ?? '').toLowerCase().includes('youtube'));
  const pool = yt.length ? yt : trailers;
  const official = pool.find(
    (t) => /official/i.test(t.title ?? '') && /trailer/i.test(t.title ?? ''),
  );
  if (official) return official;
  return pool.find((t) => /trailer/i.test(t.title ?? '')) ?? pool[0];
}

/** What the Trailer opens: an extra in the player, or a link. */
export type TrailerChoice = { local: true; extra: ExtraRef } | { local: false; link: Trailer };

/** The title's Trailer: its local trailer, else pickTrailer's link; null
 *  when it has neither. A link without a url is none. */
export function trailerChoice(
  item: { extras?: readonly ExtraRef[] | null; trailers?: readonly Trailer[] | null } | null | undefined,
): TrailerChoice | null {
  if (!item) return null;
  const extra = localTrailer(item.extras);
  if (extra) return { local: true, extra };
  const link = pickTrailer(item.trailers);
  return link && link.url ? { local: false, link } : null;
}

/** The route that plays a title's extra in the player. */
export function trailerPath(itemId: string, extraId: string): string {
  return `/trailer/${encodeURIComponent(itemId)}/${encodeURIComponent(extraId)}`;
}

/** An extra's master as the engine asks for it: its play_path resolved with
 *  the stream token (api.assetUrl), plus this TV's caps, as a title's
 *  master is asked for. */
export function extraMasterUrl(assetUrl: string, caps: string): string {
  if (!caps) return assetUrl;
  return `${assetUrl}${assetUrl.includes('?') ? '&' : '?'}caps=${encodeURIComponent(caps)}`;
}

/** Why a trailer did not play, by the status of its master: not there —
 *  400, 404, 410 — or it failed (any other status, or none). */
export function trailerFailure(status: number | null | undefined): 'not-found' | 'failed' {
  return status === 400 || status === 404 || status === 410 ? 'not-found' : 'failed';
}

/** An error the client throws for a title that is not there:
 *  "chino-api 404" (400, 410 alike). */
export function isNotFoundError(e: unknown): boolean {
  return e instanceof Error && /^chino-api (400|404|410)$/.test(e.message.trim());
}

/** Where a seek of `delta` seconds from `current` lands: never before the
 *  head, never past the end once the duration is known. */
export function seekTarget(current: number, delta: number, duration: number): number {
  const target = current + delta;
  return Math.max(0, duration > 0 ? Math.min(target, duration) : target);
}
