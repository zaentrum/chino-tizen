// node --test (type stripping, Node >= 22.18): which episode "Play" on a
// series starts. Excluded from the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInProgress, pickSeriesEpisode } from './seriesPlay.ts';

const ep = (id: string, season: number, watched = false) => ({
  id,
  season_number: season,
  watched_at: watched ? '2026-09-01T20:00:00Z' : null,
});
const episodes = [ep('s0e1', 0), ep('s1e1', 1, true), ep('s1e2', 1, true), ep('s1e3', 1), ep('s1e4', 1)];
const row = (id: string, position_sec: number, duration_sec: number, extra: Record<string, unknown> = {}) => ({
  id,
  parent_id: 'show',
  position_sec,
  duration_sec,
  ...extra,
});

test('the episode in progress resumes', () => {
  const pick = pickSeriesEpisode({
    seriesId: 'show',
    episodes,
    continueWatching: [row('other-show-ep', 900, 2400, { parent_id: 'other' }), row('s1e3', 754, 2580)],
    next: { next: { id: 's1e4' }, anchor: 's1e3' },
  });
  assert.deepEqual(pick, { episodeId: 's1e3', resumeSec: 754 });
});

test("a finished episode's next-up card plays the episode after it", () => {
  const pick = pickSeriesEpisode({
    seriesId: 'show',
    episodes,
    continueWatching: [row('s1e3', 0, 0, { up_next: true })],
    next: { next: { id: 's1e3' }, anchor: 's1e2' },
  });
  assert.deepEqual(pick, { episodeId: 's1e3', resumeSec: 0 });
});

test('beyond the feed, the last-touched episode while unfinished, else what follows it', () => {
  const unfinished = pickSeriesEpisode({
    seriesId: 'show',
    episodes,
    continueWatching: [],
    next: { next: { id: 's1e4' }, anchor: 's1e3' },
  });
  assert.deepEqual(unfinished, { episodeId: 's1e3', resumeSec: 0 });
  // Went back and re-watched episode 1: the next unwatched one, not episode 2.
  const rewatched = pickSeriesEpisode({
    seriesId: 'show',
    episodes,
    continueWatching: [],
    next: { next: { id: 's1e2' }, anchor: 's1e1' },
  });
  assert.deepEqual(rewatched, { episodeId: 's1e3', resumeSec: 0 });
});

test('never watched: the first regular episode, not a special', () => {
  const fresh = [ep('s0e1', 0), ep('s1e1', 1), ep('s1e2', 1)];
  const pick = pickSeriesEpisode({
    seriesId: 'show',
    episodes: fresh,
    continueWatching: [],
    next: { next: { id: 's0e1' } }, // the server's "first episode" sorts season 0 first
  });
  assert.deepEqual(pick, { episodeId: 's1e1', resumeSec: 0 });
});

test('a series seen to the end starts over; specials-only series play their first', () => {
  const seen = [ep('s1e1', 1, true), ep('s1e2', 1, true)];
  assert.deepEqual(
    pickSeriesEpisode({ seriesId: 'show', episodes: seen, continueWatching: [], next: { next: null } }),
    { episodeId: 's1e1', resumeSec: 0 },
  );
  assert.deepEqual(
    pickSeriesEpisode({ seriesId: 'show', episodes: [ep('s0e1', 0), ep('s0e2', 0)], continueWatching: [], next: null }),
    { episodeId: 's0e1', resumeSec: 0 },
  );
});

test("without the episode list, the server's answer stands", () => {
  assert.deepEqual(
    pickSeriesEpisode({ seriesId: 'show', episodes: [], continueWatching: [], next: { next: { id: 's2e1' }, anchor: 's1e9' } }),
    { episodeId: 's2e1', resumeSec: 0 },
  );
  assert.deepEqual(
    pickSeriesEpisode({ seriesId: 'show', episodes: [], continueWatching: [], next: { next: { id: 's1e1' } } }),
    { episodeId: 's1e1', resumeSec: 0 },
  );
  assert.equal(pickSeriesEpisode({ seriesId: 'show', episodes: [], continueWatching: [], next: null }), null);
});

test("chino-web's resume-row test", () => {
  assert.equal(isInProgress(row('a', 31, 2400)), true);
  assert.equal(isInProgress(row('a', 30, 2400)), false);
  assert.equal(isInProgress(row('a', 2340, 2400)), false);
  assert.equal(isInProgress(row('a', 900, 0)), true);
  assert.equal(isInProgress(row('a', 900, 2400, { up_next: true })), false);
});
