// node --test (type stripping, Node >= 22.18): where the remote's seeks
// start from while one is in flight. Excluded from the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEEK_LANDED_SEC, SEEK_PENDING_MS, createSeekAccumulator } from './seek.ts';

/** A clock the test moves by hand. */
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, tick: (ms: number) => void (t += ms) };
};

test('three quick +10 s presses from 1:40 land at 2:10', () => {
  // The bug: AVPlay still reported 1:40 at each press, and all three
  // landed at 1:50.
  const c = clock();
  const s = createSeekAccumulator(c.now);
  assert.equal(s.seekBy(10, 100, 5400), 110);
  c.tick(150);
  s.reported(100.3); // a tick from before the seek landed
  assert.equal(s.seekBy(10, 100.3, 5400), 120);
  c.tick(150);
  assert.equal(s.seekBy(10, 100.3, 5400), 130);
  // The scrub bar shows where it is going, not the tick.
  assert.equal(s.position(100.5), 130);
});

test('a press after the engine caught up starts from the playhead it reports', () => {
  const c = clock();
  const s = createSeekAccumulator(c.now);
  assert.equal(s.seekBy(10, 100, 5400), 110);
  s.reported(109.2); // landed, on a key frame just short of it
  c.tick(2000);
  // Played on to 1:51.2 since: from there, not from the target.
  assert.equal(s.position(111.2), 111.2);
  assert.equal(s.seekBy(10, 111.2, 5400), 121.2);
});

test('one press, an engine that reports it at once (hls.js): as before', () => {
  const c = clock();
  const s = createSeekAccumulator(c.now);
  assert.equal(s.position(42), 42);
  assert.equal(s.seekBy(10, 42, 5400), 52);
  s.reported(52);
  assert.equal(s.position(52.4), 52.4);
  assert.equal(s.seekBy(-10, 52.4, 5400), 42.4);
});

test('a seek stays between the head and the end', () => {
  const c = clock();
  const head = createSeekAccumulator(c.now);
  assert.equal(head.seekBy(-10, 5, 120), 0);
  assert.equal(head.seekBy(-10, 5, 120), 0);
  assert.equal(head.seekBy(10, 5, 120), 10);
  const end = createSeekAccumulator(c.now);
  assert.equal(end.seekBy(10, 115, 120), 120);
  assert.equal(end.seekBy(30, 115, 120), 120);
  assert.equal(end.seekBy(-30, 115, 120), 90);
  // The end not known yet: forward as asked.
  assert.equal(createSeekAccumulator(c.now).seekBy(10, 5, 0), 15);
  assert.equal(createSeekAccumulator(c.now).seekTo(130, 120), 120);
  assert.equal(createSeekAccumulator(c.now).seekTo(-3, 120), 0);
});

test('paused, the presses add up however far apart', () => {
  // A paused AVPlay reports nothing: its playhead is the one before the
  // first seek, and says nothing of where the seeks went.
  const c = clock();
  const s = createSeekAccumulator(c.now);
  assert.equal(s.seekBy(30, 100, 5400), 130);
  c.tick(400);
  assert.equal(s.seekBy(30, 100, 5400), 160);
  c.tick(10_000);
  assert.equal(s.seekBy(10, 100, 5400), 170);
  // Played again, it reports the target: the seeks landed.
  s.reported(170.5);
  c.tick(3000);
  assert.equal(s.seekBy(10, 173.5, 5400), 183.5);
});

test('paused on an engine that reports each seek, the presses add up the same', () => {
  const c = clock();
  const s = createSeekAccumulator(c.now);
  assert.equal(s.seekBy(10, 100, 5400), 110);
  s.reported(110);
  c.tick(5000);
  assert.equal(s.seekBy(10, 110, 5400), 120);
});

test('a seek the engine reports elsewhere is given up a while after it', () => {
  const c = clock();
  const s = createSeekAccumulator(c.now);
  assert.equal(s.seekBy(10, 100, 5400), 110);
  s.reported(100.5); // still where it was: the seek did not take
  s.reported(110 - SEEK_LANDED_SEC - 0.1); // near is within SEEK_LANDED_SEC
  c.tick(SEEK_PENDING_MS - 100);
  s.reported(103.4);
  assert.equal(s.position(103.4), 110);
  c.tick(100);
  // The engine is believed again.
  assert.equal(s.position(103.6), 103.6);
  assert.equal(s.seekBy(10, 103.6, 5400), 113.6);
});

test('reports before the seek, and ones that are no number, give nothing up', () => {
  const c = clock();
  const s = createSeekAccumulator(c.now);
  s.reported(100.2); // nothing in flight: nothing to keep
  assert.equal(s.seekBy(10, 100.2, 5400), 110.2);
  s.reported(Number.NaN);
  c.tick(SEEK_PENDING_MS * 2);
  assert.equal(s.position(100.2), 110.2);
});

test('a press after a skip starts from the skip', () => {
  // Skip Intro, then FF before AVPlay's next tick: from the intro's end.
  const c = clock();
  const s = createSeekAccumulator(c.now);
  assert.equal(s.seekTo(95.25, 5400), 95.25);
  assert.equal(s.seekBy(30, 12, 5400), 125.25);
});
