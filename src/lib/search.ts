// The search: one call per query, GET /api/v1/search, chino-api's search of
// the catalog — the titles of the types asked for (SEARCH_TYPES) ranked
// together by how they match the query, best first, each with how it matched
// (`match`) and an episode with its series; and the people whose names match
// it, ranked apart. The app shows both in the server's order, as they came:
// nothing here ranks them again or groups them by type. A server older than
// the search answers 404, and the search is then made as the app made it
// before: each type's list of the query (GET /api/v1/items?q=&type=), one type
// after the other, and the people (GET /api/v1/people) best effort. Pure:
// search.test.ts runs it under node --test against a fake fetch.

import type { Item, Person, SearchResult } from '../api/types';

/**
 * The types of title the search asks for, ranked together: films and series.
 * The search as before lists them one after the other, in this order.
 *
 * HOOK (episodes): no client shows episode results yet, a UX decision. To
 * show episodes, add "episode" here. Each episode hit then carries its
 * `series` (id, title, poster_url, matched) and its season/episode numbers
 * (season_number, episode_number). The agreed card, for a later UI rework and
 * not built now, shows it as its series' poster card with one line like
 * "S05E14 · Ozymandias", read from the data, opening the series on that
 * episode; and one card per series when the series also matched on its own
 * title (`series.matched`).
 */
export const SEARCH_TYPES: readonly string[] = ['movie', 'series'];

/** What one search asks for: the query, the types of title (SEARCH_TYPES),
 *  how many titles and how many people. The server caps them at 100 and 50;
 *  0 people looks for none. */
export interface SearchRequest {
  q: string;
  types: readonly string[];
  limit: number;
  people: number;
}

/** GET <api>/v1/search for a request, `apiBase` the API root ending at
 *  "/api". The types go comma separated, as chino-api reads them:
 *  "?q=…&types=movie,series&limit=60&people=12". */
export function searchUrl(apiBase: string, r: SearchRequest): string {
  const base = (apiBase || '').replace(/\/+$/, '');
  const types = r.types.map((t) => encodeURIComponent(t)).join(',');
  return `${base}/v1/search?q=${encodeURIComponent(r.q)}&types=${types}&limit=${r.limit}&people=${r.people}`;
}

/** GET /api/v1/search's answer as it came: its titles in the server's order
 *  and its people in theirs, each row as sent (`match` and an episode's
 *  `series` kept). A list that is not there is empty; a row without an id is
 *  left out. */
export function searchResultOf(raw: unknown): SearchResult {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as { items?: unknown; people?: unknown };
  return { items: rowsOf<Item>(doc.items), people: rowsOf<Person>(doc.people) };
}

function rowsOf<T extends { id: string }>(list: unknown): T[] {
  if (!Array.isArray(list)) return [];
  return list.filter((row): row is T => {
    const id = row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined;
    return typeof id === 'string' && id !== '';
  });
}

/**
 * One search: GET <api>/v1/search with the viewer's bearer, its answer read
 * by searchResultOf. A server older than the search answers 404: then
 * `asBefore`, the search as the app made it before (searchAsBefore). Any
 * other failure throws, as every catalog call does ("chino-api 502").
 */
export async function searchCatalog(opts: {
  /** chino-api's API root, ending at "/api". */
  apiBase: string;
  request: SearchRequest;
  /** The viewer's bearer, in the Authorization header. */
  headers?: HeadersInit;
  /** The search for a server without GET /api/v1/search. */
  asBefore: () => Promise<SearchResult>;
  /** For tests; the browser's fetch otherwise. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<SearchResult> {
  const doFetch = opts.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const res = await doFetch(searchUrl(opts.apiBase, opts.request), { headers: opts.headers });
  if (res.status === 404) return opts.asBefore();
  if (!res.ok) throw new Error(`chino-api ${res.status}`);
  return searchResultOf(await res.json());
}

/**
 * The search as the app made it before GET /api/v1/search, for a server
 * older than it: each type's list of the query (`list`: api.listItems, GET
 * /api/v1/items?q=&type=&limit=), each up to the limit, one after the other
 * in the request's order — films, then series; and the people (`people`:
 * api.searchPeople, GET /api/v1/people?q=&limit=), best effort: when they
 * fail the row is empty rather than the search failed. A list that fails
 * fails the search.
 */
export async function searchAsBefore(
  r: SearchRequest,
  calls: {
    list: (p: { q: string; type: string; limit: number }) => Promise<Item[]>;
    people: (q: string, limit: number) => Promise<Person[]>;
  },
): Promise<SearchResult> {
  const [lists, people] = await Promise.all([
    Promise.all(r.types.map((type) => calls.list({ q: r.q, type, limit: r.limit }))),
    r.people > 0 ? calls.people(r.q, r.people).catch(() => [] as Person[]) : Promise.resolve([] as Person[]),
  ]);
  // Not lists.flat(): the web engine of a 2018 set (Tizen 4.0) has none.
  return { items: lists.reduce<Item[]>((all, list) => all.concat(list), []), people };
}
