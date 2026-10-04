// node --test (type stripping, Node >= 22.18): the order the detail page's
// episode list shows the seasons in, and which one is open. Excluded from the
// app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opensExpanded, seasonTitle, seasonsInOrder } from './seasons.ts';

const seasons = (...numbers: number[]) => numbers.map((season) => ({ season, episodes: [`s${season}`] }));
const order = (...numbers: number[]) => seasonsInOrder(seasons(...numbers)).map((s) => s.season);

test('the specials, which chino-api lists first, come last', () => {
  assert.deepEqual(order(0, 1, 2, 3), [1, 2, 3, 0]);
});

test('the first numbered season opens, the specials stay closed', () => {
  const list = seasonsInOrder(seasons(0, 1, 2));
  assert.deepEqual(list.map((s, i) => [s.season, opensExpanded(i)]), [[1, true], [2, false], [0, false]]);
});

test('specials and nothing else: they open', () => {
  const list = seasonsInOrder(seasons(0));
  assert.deepEqual(list.map((s, i) => [s.season, opensExpanded(i)]), [[0, true]]);
});

test('the numbered seasons in order, whatever order they came in', () => {
  assert.deepEqual(order(3, 0, 1, 2), [1, 2, 3, 0]);
  assert.deepEqual(order(2, 1), [1, 2]);
  assert.deepEqual(order(), []);
});

test('each season keeps its episodes', () => {
  assert.deepEqual(seasonsInOrder(seasons(0, 1))[1].episodes, ['s0']);
});

test('the headers: "Season N", "Specials" for season 0', () => {
  assert.equal(seasonTitle(1), 'Season 1');
  assert.equal(seasonTitle(12), 'Season 12');
  assert.equal(seasonTitle(0), 'Specials');
});
