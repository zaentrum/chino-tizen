// node --test (type stripping, Node >= 22.18): the search's one call against
// a fake chino-api — what it asks for and how its answer is read — and the
// search as before, for a server older than GET /api/v1/search. Excluded from
// the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_TYPES,
  searchAsBefore,
  searchCatalog,
  searchResultOf,
  searchUrl,
  type SearchRequest,
} from './search.ts';

const API = 'https://media.example.org/api';

const request = (over: Partial<SearchRequest> = {}): SearchRequest => ({
  q: 'long road',
  types: SEARCH_TYPES,
  limit: 60,
  people: 12,
  ...over,
});

interface Sent {
  url: string;
  init: RequestInit;
}

/** A fake chino-api answering every request with [status] and [body] (JSON
 *  when an object, as writeJSON sends it; plain text when a string).
 *  Records what was sent. */
function fakeServer(status: number, body?: object | string) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    sent.push({ url, init });
    if (body === undefined) return new Response(null, { status });
    if (typeof body === 'string') {
      return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { sent, fetch };
}

/** A search as before that must not be made. */
const notAsBefore = async (): Promise<never> => {
  throw new Error('searched as before');
};

const film = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, type: 'movie', title, ...extra });
const show = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, type: 'series', title, ...extra });
const person = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, ...extra });

test('the types asked for: films and series, no episodes', () => {
  assert.deepEqual([...SEARCH_TYPES], ['movie', 'series']);
});

test('the request: GET <api>/v1/search with q, types=movie,series, limit and people, the bearer in the header', async () => {
  const server = fakeServer(200, { product: 'chino', source: 'katalog', items: [], people: [] });
  await searchCatalog({
    apiBase: API,
    request: request(),
    headers: { Authorization: 'Bearer tok' },
    asBefore: notAsBefore,
    fetch: server.fetch,
  });

  assert.equal(server.sent.length, 1);
  const [sent] = server.sent;
  assert.equal(sent.url, 'https://media.example.org/api/v1/search?q=long%20road&types=movie,series&limit=60&people=12');
  const url = new URL(sent.url);
  assert.equal(url.pathname, '/api/v1/search');
  assert.deepEqual([...url.searchParams.keys()], ['q', 'types', 'limit', 'people']);
  assert.equal(url.searchParams.get('q'), 'long road');
  assert.equal(url.searchParams.get('types'), 'movie,series');
  assert.equal(url.searchParams.get('limit'), '60');
  assert.equal(url.searchParams.get('people'), '12');
  assert.equal(sent.init.method ?? 'GET', 'GET');
  assert.equal(new Headers(sent.init.headers).get('Authorization'), 'Bearer tok');
});

test('the query goes as typed, whatever it holds; the API base with or without its slash', () => {
  for (const q of ['Tom & Jerry', 'a+b=c', '50% #1?', 'Amélie', '東京', ' spaced ']) {
    assert.equal(new URL(searchUrl(API, request({ q }))).searchParams.get('q'), q, q);
  }
  assert.equal(
    searchUrl(`${API}/`, request({ q: 'x', limit: 100, people: 0 })),
    'https://media.example.org/api/v1/search?q=x&types=movie,series&limit=100&people=0',
  );
  assert.equal(
    new URL(searchUrl(API, request({ types: ['movie', 'series', 'episode'] }))).searchParams.get('types'),
    'movie,series,episode',
  );
});

test("the answer: the titles in the server's order, films and series together, and the people as ranked", async () => {
  const items = [
    show('s1', 'Long Road', { year: 2014, rating: 8.1, watched_at: null, match: 'exact' }),
    film('m1', 'The Long Road Home', { year: 2019, poster_url: '/api/v1/items/m1/poster', match: 'prefix' }),
    show('s2', 'Road Long Taken', { watched_at: '2026-10-01T20:00:00Z', match: 'words' }),
    film('m2', 'Roadside', { min_age: 12, match: 'similar' }),
  ];
  const people = [
    person('p1', 'Rhoda Long', { credits: 3, has_profile: true, profile_url: '/api/v1/people/p1/profile', match: 'prefix' }),
    person('p2', 'Longo Ruiz', { match: 'similar' }),
  ];
  const server = fakeServer(200, { product: 'chino', source: 'katalog', items, people });
  const got = await searchCatalog({ apiBase: API, request: request(), asBefore: notAsBefore, fetch: server.fetch });

  assert.deepEqual(got.items.map((i) => i.id), ['s1', 'm1', 's2', 'm2']);
  assert.deepEqual(got.items, items, 'each title as it came, match included');
  assert.deepEqual(got.people, people, 'each person as they came, in their order');
});

test("an episode keeps its series and its numbers; nothing more is made of them", () => {
  const episode = {
    id: 'e514',
    type: 'episode',
    title: 'The Crossing',
    season_number: 5,
    episode_number: 14,
    parent_id: 's1',
    match: 'exact',
    series: { id: 's1', title: 'Long Road', matched: true, poster_url: '/api/v1/items/s1/poster' },
  };
  const got = searchResultOf({ items: [show('s1', 'Long Road', { match: 'prefix' }), episode], people: [] });
  assert.deepEqual(got.items.map((i) => i.id), ['s1', 'e514']);
  assert.deepEqual(got.items[1], episode);
});

test('an answer without a list is an empty one; a row without an id is left out', () => {
  const none = { items: [], people: [] };
  assert.deepEqual(searchResultOf({ product: 'chino', source: 'katalog', items: [], people: [] }), none);
  assert.deepEqual(searchResultOf({ product: 'chino' }), none);
  assert.deepEqual(searchResultOf({ items: null, people: 'none' }), none);
  assert.deepEqual(searchResultOf(null), none);
  assert.deepEqual(searchResultOf('<html>502 Bad Gateway</html>'), none);
  const got = searchResultOf({
    items: [null, 'x', 7, { title: 'no id' }, { id: '', title: 'empty id' }, { id: 3, title: 'number id' }, film('m1', 'Kept')],
    people: [{ name: 'no id' }, person('p1', 'Kept')],
  });
  assert.deepEqual(got.items.map((i) => i.id), ['m1']);
  assert.deepEqual(got.people.map((p) => p.id), ['p1']);
});

test('a search that finds nothing is an empty answer, not the search as before', async () => {
  const server = fakeServer(200, { product: 'chino', source: 'katalog', items: [], people: [] });
  assert.deepEqual(
    await searchCatalog({ apiBase: API, request: request(), asBefore: notAsBefore, fetch: server.fetch }),
    { items: [], people: [] },
  );
});

test('404, a server older than the search: films, then series, and the people, as before', async () => {
  const server = fakeServer(404, '404 page not found\n');
  const lists: { q: string; type: string; limit: number }[] = [];
  const peopleAsked: [string, number][] = [];
  const films = [film('m1', 'The Long Road Home'), film('m2', 'Roadside')];
  const shows = [show('s1', 'Long Road')];
  const people = [person('p1', 'Rhoda Long', { credits: 3 })];
  const r = request();
  const got = await searchCatalog({
    apiBase: API,
    request: r,
    headers: { Authorization: 'Bearer tok' },
    fetch: server.fetch,
    asBefore: () =>
      searchAsBefore(r, {
        list: async (p) => {
          lists.push(p);
          return p.type === 'movie' ? films : p.type === 'series' ? shows : [];
        },
        people: async (q, limit) => {
          peopleAsked.push([q, limit]);
          return people;
        },
      }),
  });

  assert.equal(server.sent.length, 1, 'GET /api/v1/search once, then the lists');
  // The three calls the search made before: each type's list of the query,
  // up to the limit, and the people.
  assert.deepEqual(lists, [
    { q: 'long road', type: 'movie', limit: 60 },
    { q: 'long road', type: 'series', limit: 60 },
  ]);
  assert.deepEqual(peopleAsked, [['long road', 12]]);
  assert.deepEqual(got.items.map((i) => i.id), ['m1', 'm2', 's1'], 'films first, then series');
  assert.deepEqual(got.people, people);
});

test('the search as before: people that fail leave the row empty; a list that fails fails the search', async () => {
  const films = [film('m1', 'The Long Road Home')];
  const noPeople = await searchAsBefore(request(), {
    list: async (p) => (p.type === 'movie' ? films : []),
    people: async () => {
      throw new Error('chino-api 404');
    },
  });
  assert.deepEqual(noPeople, { items: films, people: [] });

  await assert.rejects(
    searchAsBefore(request(), {
      list: async (p) => {
        if (p.type === 'series') throw new Error('chino-api 502');
        return films;
      },
      people: async () => [person('p1', 'Rhoda Long')],
    }),
    { message: 'chino-api 502' },
  );

  // No people asked for: none looked up.
  let asked = 0;
  const without = await searchAsBefore(request({ people: 0 }), {
    list: async () => films,
    people: async () => {
      asked++;
      return [person('p1', 'Rhoda Long')];
    },
  });
  assert.equal(asked, 0);
  assert.deepEqual(without.people, []);
});

test('any other failure is a failed search, not the search as before', async () => {
  for (const status of [400, 401, 403, 500, 502, 503]) {
    const server = fakeServer(status, { product: 'chino', error: 'catalog unavailable' });
    await assert.rejects(
      searchCatalog({ apiBase: API, request: request(), asBefore: notAsBefore, fetch: server.fetch }),
      { message: `chino-api ${status}` },
      String(status),
    );
  }
  // No answer at all.
  const offline = async (): Promise<Response> => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(
    searchCatalog({ apiBase: API, request: request(), asBefore: notAsBefore, fetch: offline }),
    TypeError,
  );
  // An answer that is not JSON, a proxy's page.
  const proxy = fakeServer(200, '<html><body>Sign in</body></html>');
  await assert.rejects(
    searchCatalog({ apiBase: API, request: request(), asBefore: notAsBefore, fetch: proxy.fetch }),
    SyntaxError,
  );
});
