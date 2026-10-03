// node --test (type stripping, Node >= 22.18): where playback resumes and what
// the player may write back as the resume position. Excluded from the app's
// tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProgressGuard,
  mayWriteProgress,
  resumeStartSec,
} from './progress.ts';

test('the saved position from /progress is where playback resumes', () => {
  assert.equal(resumeStartSec({ savedSec: 1834, durationSec: 5400 }), 1834);
  assert.equal(resumeStartSec({ savedSec: 1834.9, durationSec: 0 }), 1834);
});

test('a barely started or a finished position starts at the head', () => {
  assert.equal(resumeStartSec({ savedSec: 30, durationSec: 5400 }), 0);
  assert.equal(resumeStartSec({ savedSec: 0, durationSec: 5400 }), 0);
  assert.equal(resumeStartSec({ savedSec: 5340, durationSec: 5400 }), 0);
  assert.equal(resumeStartSec({ savedSec: 5339, durationSec: 5400 }), 5339);
});

test('start over wins over everything, a Zap hand-off over the saved position', () => {
  assert.equal(resumeStartSec({ savedSec: 1834, durationSec: 5400, startover: true, handoffSec: 600 }), 0);
  assert.equal(resumeStartSec({ savedSec: 1834, durationSec: 5400, handoffSec: 600 }), 600);
  assert.equal(resumeStartSec({ savedSec: 1834, durationSec: 5400, handoffSec: 1 }), 1834);
});

test('an unreadable saved position starts at the head and writes nothing', () => {
  assert.equal(resumeStartSec({ savedSec: null, durationSec: 5400 }), 0);
  assert.equal(mayWriteProgress({ savedSec: null, durationSec: 5400 }), false);
  // The viewer chose where to start: what they play from there is theirs.
  assert.equal(mayWriteProgress({ savedSec: null, durationSec: 5400, startover: true }), true);
  assert.equal(mayWriteProgress({ savedSec: null, durationSec: 5400, handoffSec: 600 }), true);
  // "Never watched" reads as 0, not as unknown.
  assert.equal(mayWriteProgress({ savedSec: 0, durationSec: 5400 }), true);
});

test('nothing is written before playback reports a position', () => {
  const g = createProgressGuard({ writable: true });
  assert.equal(g.position(), null);
  g.played(0);
  g.played(Number.NaN);
  assert.equal(g.position(), null);
});

test('the head of the stream before the resume seek lands is never written', () => {
  // The bug: a session that resumed at 30:34 wrote the 0:0x it reported
  // before the seek landed, and every other device lost its place.
  const g = createProgressGuard({ writable: true });
  g.expectSeek(1834);
  g.played(0.2);
  g.played(1.4);
  assert.equal(g.position(), null);
  g.played(1830.5); // landed on the segment boundary just before the target
  assert.equal(g.position(), 1830);
  g.played(1841.2);
  assert.equal(g.position(), 1841);
});

test('a seek the viewer made is not a position until playback gets there', () => {
  const g = createProgressGuard({ writable: true });
  g.played(600.7);
  g.expectSeek(1200); // fast-forward pressed; BACK before the seek lands
  g.played(601.1); // the old position, reported while the seek is pending
  assert.equal(g.position(), 600);
  g.played(1200.4);
  assert.equal(g.position(), 1200);
  // Seeking back: the positions on the way are real, the target is reached.
  g.expectSeek(900);
  g.played(1201);
  g.played(900.2);
  assert.equal(g.position(), 900);
});

test('a quality switch keeps the last played position until the reload plays', () => {
  const g = createProgressGuard({ writable: true });
  g.played(2400.9);
  g.expectSeek(2400);
  g.played(0.5); // the reloaded stream before its seek lands
  assert.equal(g.position(), 2400);
});

test('a session that may not write never writes', () => {
  const g = createProgressGuard({ writable: false });
  g.played(42);
  assert.equal(g.position(), null);
});
