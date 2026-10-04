// The detail page's episode list, season by season. chino-api groups a
// series' episodes by season with season 0 — the specials, and episodes
// without coordinates — first; the list shows the numbered seasons in order,
// opens on the first of them, and puts the specials last and closed. chino-web
// keeps the specials out of the way the same way: its list opens on the first
// numbered season. Pure: seasons.test.ts runs it under node --test.

export interface SeasonLike {
  season: number;
}

/** The seasons as the list shows them: the numbered ones in order, then the
 *  specials (season 0). */
export function seasonsInOrder<T extends SeasonLike>(seasons: readonly T[]): T[] {
  const numbered = seasons.filter((s) => s.season > 0).sort((a, b) => a.season - b.season);
  return [...numbered, ...seasons.filter((s) => !(s.season > 0))];
}

/** Whether a season of the list in order shows its episodes when the page
 *  opens: the first one — the first numbered season, or the specials when
 *  they are all there is. */
export function opensExpanded(index: number): boolean {
  return index === 0;
}

/** What a season's header says: "Season 2", "Specials" for season 0. */
export function seasonTitle(season: number): string {
  return season > 0 ? `Season ${season}` : 'Specials';
}
