// node --test (type stripping, Node >= 22.18): what a title's Trailer plays.
// Excluded from the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRAILER_KINDS,
  extraMasterUrl,
  findExtra,
  isNotFoundError,
  localTrailer,
  pickTrailer,
  trailerChoice,
  trailerFailure,
  trailerPath,
} from './trailers.ts';

const ITEM = '9c4e7a12-0000-4000-8000-000000000001';
const extra = (id: string, kind: string, more: Record<string, unknown> = {}) => ({
  id,
  kind,
  title: kind,
  local: true,
  play_path: `/api/v1/items/${ITEM}/extras/${id}/play/master.m3u8`,
  ...more,
});
const yt = (key: string, title: string) => ({
  site: 'YouTube',
  external_id: key,
  url: `https://www.youtube.com/watch?v=${key}`,
  title,
});

test('a trailer, then a teaser', () => {
  assert.deepEqual([...TRAILER_KINDS], ['trailer', 'teaser']);
  assert.equal(localTrailer([extra('t1', 'teaser'), extra('tr', 'trailer')])?.id, 'tr');
  assert.equal(localTrailer([extra('t1', 'teaser'), extra('f', 'featurette')])?.id, 't1');
});

test("a trailer beats a teaser whatever the season: a season's trailer before the whole title's teaser", () => {
  const seasonTrailer = extra('s2-trailer', 'trailer', { season_number: 2 });
  const wholeTeaser = extra('teaser', 'teaser');
  assert.equal(localTrailer([wholeTeaser, seasonTrailer])?.id, 's2-trailer');
  assert.equal(localTrailer([seasonTrailer, wholeTeaser])?.id, 's2-trailer');
  // A season 0 (the specials) is a season too.
  assert.equal(localTrailer([extra('w', 'teaser'), extra('sp', 'trailer', { season_number: 0 })])?.id, 'sp');
});

test("within a kind, the whole title's extra before a season's, then the server's order", () => {
  const s2 = extra('s2', 'trailer', { season_number: 2 });
  const s1 = extra('s1', 'trailer', { season_number: 1 });
  assert.equal(localTrailer([s2, extra('whole', 'trailer')])?.id, 'whole');
  assert.equal(localTrailer([extra('t-s1', 'teaser', { season_number: 1 }), extra('t', 'teaser')])?.id, 't');
  assert.equal(localTrailer([s2, s1])?.id, 's2');
  assert.equal(localTrailer([extra('a', 'trailer'), extra('b', 'trailer')])?.id, 'a');
});

test('no trailer: none of those kinds, nothing that plays here, no extras', () => {
  assert.equal(localTrailer([extra('f', 'featurette'), extra('b', 'behind-the-scenes')]), null);
  assert.equal(localTrailer([extra('r', 'trailer', { local: false }), extra('p', 'trailer', { play_path: '' })]), null);
  assert.equal(localTrailer([extra('', 'trailer')]), null);
  assert.equal(localTrailer([]), null);
  assert.equal(localTrailer(undefined), null);
  assert.equal(localTrailer(null), null);
});

test('it plays here only with local: true - not when local is left out', () => {
  const { local: _local, ...unflagged } = extra('u', 'trailer');
  assert.equal(localTrailer([unflagged as never]), null);
  assert.equal(findExtra([unflagged as never], 'u'), null);
  assert.equal(localTrailer([unflagged as never, extra('ok', 'teaser')])?.id, 'ok');
});

test('a kind in capitals is still that kind', () => {
  assert.equal(localTrailer([extra('T', 'Trailer')])?.id, 'T');
});

test('the trailer screen finds its extra by id, of any kind that plays here', () => {
  const list = [extra('tr', 'trailer'), extra('ft', 'featurette'), extra('gone', 'trailer', { play_path: '' })];
  assert.equal(findExtra(list, 'ft')?.id, 'ft');
  assert.equal(findExtra(list, 'gone'), null);
  assert.equal(findExtra(list, 'nope'), null);
  assert.equal(findExtra(undefined, 'tr'), null);
});

test("the link pick as before: YouTube, an official trailer, any trailer, the first", () => {
  const vimeo = { site: 'Vimeo', url: 'https://vimeo.com/1', title: 'Official Trailer' };
  assert.equal(pickTrailer([vimeo, yt('a', 'Teaser'), yt('b', 'Official Trailer')])?.external_id, 'b');
  assert.equal(pickTrailer([yt('a', 'Teaser'), yt('b', 'Trailer 2')])?.external_id, 'b');
  assert.equal(pickTrailer([yt('a', 'Teaser'), yt('b', 'Clip')])?.external_id, 'a');
  assert.equal(pickTrailer([vimeo])?.url, 'https://vimeo.com/1');
  assert.equal(pickTrailer([]), null);
  assert.equal(pickTrailer(undefined), null);
});

test('the Trailer: the local trailer first, else the link, else none', () => {
  const links = [yt('x1', 'Official Trailer')];
  const local = trailerChoice({ extras: [extra('tr', 'trailer')], trailers: links });
  assert.equal(local?.local === true ? local.extra.id : null, 'tr');
  const link = trailerChoice({ extras: [extra('f', 'featurette')], trailers: links });
  assert.equal(link?.local === false ? link.link.url : null, 'https://www.youtube.com/watch?v=x1');
  // A server older than extras sends none: the link, as before.
  assert.equal(trailerChoice({ trailers: links })?.local, false);
  assert.equal(trailerChoice({ extras: [extra('t', 'teaser')] })?.local, true);
  assert.equal(trailerChoice({}), null);
  assert.equal(trailerChoice({ trailers: [{ site: 'YouTube', url: '' }] }), null);
  assert.equal(trailerChoice(null), null);
});

test('the trailer route carries both ids, escaped', () => {
  assert.equal(trailerPath('a b', 'c/d'), '/trailer/a%20b/c%2Fd');
  assert.equal(trailerPath(ITEM, 'x1'), `/trailer/${ITEM}/x1`);
});

test("an extra's master: the asset URL with this TV's caps", () => {
  const asset = `https://media.example.org/api/v1/items/${ITEM}/extras/x1/play/master.m3u8?stream=tok`;
  assert.equal(extraMasterUrl(asset, 'avc,hvc:2160,aac'), `${asset}&caps=avc%2Chvc%3A2160%2Caac`);
  assert.equal(extraMasterUrl(asset, ''), asset);
  const bare = asset.split('?')[0];
  assert.equal(extraMasterUrl(bare, 'avc'), `${bare}?caps=avc`);
  const u = new URL(extraMasterUrl(asset, 'avc,aac'));
  assert.equal(u.searchParams.get('stream'), 'tok');
  assert.equal(u.searchParams.get('caps'), 'avc,aac');
});

test('not there (400, 404, 410) is not available; anything else failed', () => {
  for (const s of [400, 404, 410]) assert.equal(trailerFailure(s), 'not-found');
  for (const s of [401, 403, 500, 502, 0, null, undefined]) assert.equal(trailerFailure(s), 'failed');
  assert.equal(isNotFoundError(new Error('chino-api 404')), true);
  assert.equal(isNotFoundError(new Error('chino-api 410')), true);
  assert.equal(isNotFoundError(new Error('chino-api 400')), true);
  assert.equal(isNotFoundError(new Error('chino-api 502')), false);
  assert.equal(isNotFoundError(new Error('Failed to fetch')), false);
  assert.equal(isNotFoundError('chino-api 404'), false);
});
