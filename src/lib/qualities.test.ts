// node --test (type stripping, Node >= 22.18): the player's quality menu
// from /play/info's qualities. Excluded from the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO, chosenQuality, qualityMenu } from './qualities.ts';

// /play/info of a packaged ladder, as the client maps it ({ name } → { id }).
const ladder = {
  mode: 'packaged',
  qualities: [
    { id: 'auto', label: 'Auto' },
    { id: 'v0', label: '2160p' },
    { id: 'v1', label: '1080p' },
    { id: 'v2', label: '720p' },
  ],
};

test("a packaged ladder: Auto, then the rungs as the server lists them", () => {
  assert.deepEqual(
    qualityMenu(ladder).map((e) => e.label),
    ['Auto', '2160p', '1080p', '720p'],
  );
});

test('Auto comes first, and is put there when the server leaves it out', () => {
  const late = { mode: 'packaged', qualities: [{ id: 'v1', label: '1080p' }, { id: 'auto', label: 'Auto' }, { id: 'v2', label: '720p' }] };
  assert.deepEqual(qualityMenu(late).map((e) => e.id), ['auto', 'v1', 'v2']);
  const none = { mode: 'packaged', qualities: [{ id: 'v1', label: '1080p' }, { id: 'v2', label: '720p' }] };
  assert.deepEqual(qualityMenu(none), [{ id: AUTO, label: 'Auto' }, { id: 'v1', label: '1080p' }, { id: 'v2', label: '720p' }]);
});

test('nothing to choose: no menu', () => {
  assert.deepEqual(qualityMenu({ mode: 'packaged', qualities: null }), []);
  assert.deepEqual(qualityMenu({ mode: 'packaged', qualities: [{ id: 'auto', label: 'Auto' }] }), []);
  assert.deepEqual(qualityMenu({ mode: 'passthrough', qualities: [] }), []);
  assert.deepEqual(qualityMenu(null), []);
  assert.deepEqual(qualityMenu(undefined), []);
});

test('an on-the-fly ladder is shown as listed, with no Auto', () => {
  const fly = {
    mode: 'transcode',
    qualities: [
      { id: 'high', label: 'High (source resolution)' },
      { id: 'medium', label: 'Medium (720p)' },
      { id: 'low', label: 'Low (480p)' },
    ],
  };
  assert.deepEqual(qualityMenu(fly).map((e) => e.id), ['high', 'medium', 'low']);
});

test('entries without a name or a label, and repeats, are left out', () => {
  const messy = {
    mode: 'packaged',
    qualities: [
      { id: 'auto', label: 'Auto' },
      { id: '', label: '480p' },
      { id: 'v1', label: '' },
      { id: 'v2', label: '720p' },
      { id: 'v2', label: '720p again' },
      { id: 'v3', label: '360p' },
    ],
  };
  assert.deepEqual(qualityMenu(messy).map((e) => e.label), ['Auto', '720p', '360p']);
});

test('the entry the player is on: the rung asked for, else Auto', () => {
  const menu = qualityMenu(ladder);
  assert.equal(chosenQuality(menu, 'v1')?.label, '1080p');
  assert.equal(chosenQuality(menu, 'auto')?.label, 'Auto');
  // Anything else is what chino-stream serves as the ladder.
  assert.equal(chosenQuality(menu, 'high')?.label, 'Auto');
  assert.equal(chosenQuality(menu, 'v9')?.label, 'Auto');
  assert.equal(chosenQuality(menu, '')?.label, 'Auto');
  assert.equal(chosenQuality(menu, undefined)?.label, 'Auto');
});

test('on the fly the entry asked for, else the first; nothing for no menu', () => {
  const menu = qualityMenu({ mode: 'transcode', qualities: [{ id: 'high', label: 'High' }, { id: 'low', label: 'Low' }] });
  assert.equal(chosenQuality(menu, 'low')?.id, 'low');
  assert.equal(chosenQuality(menu, '')?.id, 'high');
  assert.equal(chosenQuality([], 'auto'), null);
});
