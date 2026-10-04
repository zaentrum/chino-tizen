// node --test (type stripping, Node >= 22.18): the audio track the player
// switches to for the Settings preference and for a track picked before a
// quality switch. Excluded from the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioLabels, audioTrackFor, trackLanguage } from './audio.ts';
import { knownLanguage, playingAudioLanguage } from './subtitles.ts';

const tracks = (...langs: (string | undefined)[]) =>
  langs.map((lang, i) => ({ id: String(i), lang, label: `Track ${i}`, selected: i === 0 }));

test('the preferred language in any spelling the stream uses', () => {
  for (const tag of ['de', 'ger', 'deu', 'DE', 'de-CH']) {
    assert.equal(audioTrackFor(tracks('eng', tag), { lang: 'de' }), '1', tag);
  }
  // The setting stores 639-1; a 639-2 one matches as well.
  assert.equal(audioTrackFor(tracks('en', 'fr'), { lang: 'fre' }), '1');
});

test('a track that names its language only in its label', () => {
  const byName = [
    { id: 'a', label: 'English', selected: true },
    { id: 'b', label: 'Deutsch' },
    { id: 'c', label: 'French 5.1' },
  ];
  assert.equal(audioTrackFor(byName, { lang: 'de' }), 'b');
  assert.equal(audioTrackFor(byName, { lang: 'fr' }), 'c');
  assert.equal(trackLanguage({ label: 'No commentary' }), '', 'a word is not a language');
});

test('nothing to switch: no preference, no track in it, or it plays already', () => {
  assert.equal(audioTrackFor(tracks('eng', 'ger'), null), null);
  assert.equal(audioTrackFor(tracks('eng', 'ger'), { lang: '' }), null);
  assert.equal(audioTrackFor(tracks('eng', 'ger'), { lang: 'ja' }), null);
  assert.equal(audioTrackFor(tracks('ger', 'eng'), { lang: 'de' }), null, 'German plays already');
  assert.equal(audioTrackFor([], { lang: 'de' }), null);
  assert.equal(audioTrackFor(tracks(undefined, undefined), { lang: 'de' }), null);
});

test('two of one language: the label picked, else its place, else the one playing', () => {
  const two = [
    { id: '0', lang: 'en', label: 'English', selected: true },
    { id: '1', lang: 'en', label: 'English 2' },
    { id: '2', lang: 'de', label: 'German' },
  ];
  assert.equal(audioTrackFor(two, { lang: 'en', label: 'English 2', place: 1 }), '1');
  assert.equal(audioTrackFor(two, { lang: 'en', label: 'Commentary', place: 1 }), '1', 'by place');
  assert.equal(audioTrackFor(two, { lang: 'en' }), null, 'the one playing is in it');
  const none = two.map((t) => ({ ...t, selected: t.id === '2' }));
  assert.equal(audioTrackFor(none, { lang: 'en' }), '0', 'else the first');
});

test('a pick that names no language is found by its label, else by its place', () => {
  const und = [
    { id: '10', label: 'Audio 1', selected: true },
    { id: '11', label: 'Director' },
  ];
  assert.equal(audioTrackFor(und, { label: 'director' }), '11');
  assert.equal(audioTrackFor(und, { place: 1 }), '11');
  assert.equal(audioTrackFor(und, { place: 0 }), null);
  assert.equal(audioTrackFor(und, { place: 7 }), null);
});

test('after a quality switch the pick is found again in the new list', () => {
  // A new master lists the renditions again, under new engine ids, the
  // DEFAULT (English) playing.
  const picked = { lang: 'ger', label: 'German', place: 1 };
  const reloaded = [
    { id: '4', lang: 'eng', label: 'English', selected: true },
    { id: '5', lang: 'ger', label: 'German' },
  ];
  assert.equal(audioTrackFor(reloaded, picked), '5');
});

test('menu labels: the stream\'s name, else the language and its layout, else "Audio N"', () => {
  assert.deepEqual(
    audioLabels([
      { lang: 'ger', channels: 2 },
      { lang: 'ger', channels: 6 },
      { lang: 'eng', name: 'Commentary' },
      { lang: 'und' },
      { lang: 'fre', channels: 8 },
      { lang: 'de' },
    ]),
    ['German', 'German 5.1', 'Commentary', 'Audio 4', 'French 7.1', 'German 2'],
  );
});

test('a label names a language outright, or by its first word', () => {
  assert.equal(knownLanguage('Deutsch'), 'de');
  assert.equal(knownLanguage('German 5.1'), 'de');
  assert.equal(knownLanguage('English (SDH)'), 'en');
  assert.equal(knownLanguage('pt_BR'), 'pt');
  assert.equal(knownLanguage('ger'), 'de');
  assert.equal(knownLanguage('Track 2'), '');
  assert.equal(knownLanguage('In memoriam'), '');
  assert.equal(knownLanguage(''), '');
  assert.equal(knownLanguage(undefined), '');
});

test('the audio that plays: the preferred language when a track is in it', () => {
  const info = [
    { language: 'eng', default: true },
    { language: 'ger' },
  ];
  assert.equal(playingAudioLanguage(info, 'de'), 'de');
  assert.equal(playingAudioLanguage(info, 'deu'), 'de');
  assert.equal(playingAudioLanguage(info, 'fr'), 'en', 'no French track: the default plays');
  assert.equal(playingAudioLanguage(info, undefined), 'en');
  assert.equal(playingAudioLanguage([], 'de'), '');
});
