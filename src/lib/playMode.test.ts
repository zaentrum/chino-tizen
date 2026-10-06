// node --test (type stripping, Node >= 22.18): what the player asks for, for a
// title and for one of a title's extras. Excluded from the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extraHeading, playPlan, type PlayPlan } from './playMode.ts';

/** The questions a plan answers yes to, in order. */
const yes = (plan: PlayPlan) =>
  Object.entries(plan)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .sort();

/** What a title has that an extra never asks for. */
const TITLE_ONLY = ['playInfo', 'progress', 'watched', 'subtitles', 'segments', 'trickplay', 'nextEpisode'] as const;

test("a title asks for all a title has: play info, progress, watched, subtitles, segments, trickplay, next episode", () => {
  assert.deepEqual(yes(playPlan('title')), [...TITLE_ONLY].sort());
});

test('a title plays as before: no master check, and the engine left to start it', () => {
  const plan = playPlan('title');
  assert.equal(plan.checkMaster, false);
  assert.equal(plan.playOnLoad, false);
});

test("an extra asks for nothing of a title's: its master, checked first, played once loaded", () => {
  const plan = playPlan('extra');
  assert.deepEqual(yes(plan), ['checkMaster', 'playOnLoad']);
  // No play info, no progress read or written (so no resume, and never in
  // Continue watching), no watched, no subtitles, no skip intro / credits, no
  // trickplay, no next episode.
  for (const k of TITLE_ONLY) assert.equal(plan[k], false, k);
});

test("a mode not known is asked for nothing of a title's", () => {
  assert.deepEqual(playPlan('trailer' as never), playPlan('extra'));
  assert.deepEqual(playPlan(undefined as never), playPlan('extra'));
});

test('every mode answers every question, yes or no', () => {
  const title = playPlan('title');
  const extra = playPlan('extra');
  assert.deepEqual(Object.keys(title).sort(), Object.keys(extra).sort());
  for (const v of [...Object.values(title), ...Object.values(extra)]) assert.equal(typeof v, 'boolean');
});

test("an extra's title bar: the title, then the extra", () => {
  assert.equal(extraHeading('Big Buck Bunny', 'Trailer'), 'Big Buck Bunny · Trailer');
  assert.equal(extraHeading(' A Series ', ' Season 2 Trailer '), 'A Series · Season 2 Trailer');
  // Either alone when the other is missing.
  assert.equal(extraHeading('Big Buck Bunny', ''), 'Big Buck Bunny');
  assert.equal(extraHeading('Big Buck Bunny', undefined), 'Big Buck Bunny');
  assert.equal(extraHeading(null, 'Teaser'), 'Teaser');
  assert.equal(extraHeading(undefined, null), '');
});
