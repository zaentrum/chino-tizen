// node --test (type stripping, Node >= 22.18): the audio track the player
// switches to for the Settings preference and for a track picked before a
// quality switch. Excluded from the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioLabels, audioTrackFor, trackLanguage, withPlayInfo } from './audio.ts';
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

// The one audio group chino-stream serves caps with eac3: each 5.1 E-AC-3
// companion just before its stereo twin, the companion the default.
const union = [
  { id: 'a2', lang: 'en', name: 'English 5.1', channels: 6, label: 'English 5.1', selected: true },
  { id: 'a0', lang: 'en', name: 'English', channels: 2, label: 'English' },
  { id: 'a3', lang: 'de', name: 'German 5.1', channels: 6, label: 'German 5.1' },
  { id: 'a1', lang: 'de', name: 'German', channels: 2, label: 'German' },
];

test('the 5.1 companions: the one picked by its name, the preferred language on its 5.1', () => {
  // The stereo twin picked, found again after a quality switch by its name -
  // not at the place it was picked at, where the order differs.
  const reloaded = [union[1], union[0], union[2], union[3]].map((t) => ({ ...t, selected: t.id === 'a2' }));
  assert.equal(audioTrackFor(reloaded, { lang: 'en', name: 'English', label: 'Track', place: 1 }), 'a0');
  assert.equal(audioTrackFor(union, { lang: 'en', name: 'english', place: 0 }), 'a0', 'the name in any case');
  assert.equal(audioTrackFor(union, { name: 'German 5.1' }), 'a3', 'a pick that names no language');
  assert.equal(audioTrackFor(union, { lang: 'en', name: 'English 5.1' }), null, 'it plays already');
  // Settings → Audio: the language, on the track playing in it, else the
  // first - the companion.
  assert.equal(audioTrackFor(union, { lang: 'en' }), null);
  assert.equal(audioTrackFor(union, { lang: 'de' }), 'a3');
  assert.deepEqual(
    audioLabels(union.map(({ lang, name, channels }) => ({ lang, name, channels }))),
    ['English 5.1', 'English', 'German 5.1', 'German'],
  );
});

test("/play/info's group fills in what the engine does not say: names and channels", () => {
  // AVPlay: no NAME, and here no channels for a rendition it has not played.
  const engine = [
    { id: '1', lang: 'eng', label: 'English', selected: true },
    { id: '2', lang: 'eng', label: 'English 2' },
    { id: '3', lang: 'ger', channels: 2, label: 'German' },
  ];
  const info = [
    { index: 0, codec: 'ec-3', language: 'en', name: 'English 5.1', channels: 6, default: true, group: 'audio-surround', rendition: 'a2' },
    { index: 1, codec: 'mp4a.40.2', language: 'en', name: 'English', channels: 2, group: 'audio-surround', rendition: 'a0' },
    { index: 2, codec: 'mp4a.40.2', language: 'de', name: 'German', channels: 2, group: 'audio-surround', rendition: 'a1' },
  ];
  const tracks = withPlayInfo(engine, info);
  assert.deepEqual(
    tracks.map((t) => [t.id, t.label, t.name, t.channels, t.selected ?? false]),
    [
      ['1', 'English 5.1', 'English 5.1', 6, true],
      ['2', 'English', 'English', 2, false],
      ['3', 'German', 'German', 2, false],
    ],
  );
  // A track the engine names no language of takes /play/info's.
  assert.equal(withPlayInfo([{ id: '1', label: 'Unknown' }], [info[0]])[0].label, 'English 5.1');
});

test("/play/info is left out where it does not line up with the engine's tracks", () => {
  const engine = [
    { id: '1', lang: 'en', label: 'English' },
    { id: '2', lang: 'de', label: 'German' },
  ];
  const row = (language: string, channels: number, group?: string) => ({ language, name: `Track ${language}`, channels, group });
  const unchanged = (tracks: typeof engine, info: Parameters<typeof withPlayInfo>[1]) =>
    assert.deepEqual(withPlayInfo(tracks, info), tracks);
  unchanged(engine, null);
  unchanged(engine, []);
  // Not as many.
  unchanged(engine, [row('en', 6, 'g')]);
  // Another language at a place.
  unchanged(engine, [row('de', 2, 'g'), row('en', 2, 'g')]);
  // Another channel count than the engine says.
  unchanged([{ ...engine[0], channels: 2 }, engine[1]], [row('en', 6, 'g'), row('de', 2, 'g')]);
  // Rows without a group: a source's tracks on the fly, whose channels are
  // the source's, not the stream's (stereo AAC).
  unchanged(engine, [row('en', 6), row('de', 6)]);
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

test('menu labels: the language and its layout, the stream\'s name where there is none, else "Unknown"', () => {
  assert.deepEqual(
    audioLabels([
      { lang: 'ger', channels: 2 },
      { lang: 'ger', channels: 6 },
      { lang: 'eng', name: 'Commentary' },
      { lang: 'und' },
      { lang: 'fre', channels: 8 },
      { lang: 'de' },
      { lang: 'und', name: 'Director\'s Commentary' },
      { name: 'Commentary 5.1', channels: 6 },
    ]),
    ['German', 'German 5.1', 'English', 'Unknown', 'French 7.1', 'German 2', 'Director\'s Commentary', 'Commentary 5.1'],
  );
});

test('mul: "Multiple languages", mis: "Other language"', () => {
  assert.deepEqual(
    audioLabels([{ lang: 'mul', name: 'mul' }, { lang: 'mis' }, { lang: 'mul', name: 'Original', channels: 2 }]),
    ['Multiple languages', 'Other language', 'Multiple languages (Original)'],
  );
});

test('zxx, no linguistic content: "No dialogue"', () => {
  assert.deepEqual(
    audioLabels([{ lang: 'zxx' }, { lang: 'ZXX', name: 'No dialogue', channels: 6 }, { lang: 'zxx', name: 'zxx', channels: 2 }]),
    ['No dialogue', 'No dialogue 5.1', 'No dialogue 2'],
  );
});

test('an old playlist\'s free-text names: a format, a number or a code is no label', () => {
  assert.deepEqual(
    audioLabels([
      { lang: 'eng', name: 'AC3 5.1 @ 640 Kbps', channels: 2 },
      { lang: 'fre', name: 'DTS-HD Master Audio / 5.1 / 48 kHz / 2618 kbps / 24-bit' },
      { lang: 'ger', name: 'Deutsch' },
      { lang: 'und', name: 'Track 0' },
      { lang: 'und', name: 'Dolby Digital 5.1' },
      { lang: 'und', name: 'und' },
    ]),
    ['English', 'French', 'German', 'Unknown', 'Unknown 2', 'Unknown 3'],
  );
});

test('two of one language: told apart by what their names say, else numbered', () => {
  assert.deepEqual(
    audioLabels([
      { lang: 'en', name: 'English', channels: 2 },
      { lang: 'en', name: 'Commentary', channels: 2 },
      { lang: 'en', name: 'English (SDH)', channels: 2 },
      { lang: 'en', name: 'English (2)', channels: 2 },
      { lang: 'en', name: 'English 5.1', channels: 6 },
      { lang: 'en', name: 'Commentary 5.1', channels: 6 },
    ]),
    ['English', 'English (Commentary)', 'English (SDH)', 'English 2', 'English 5.1', 'English 5.1 (Commentary)'],
  );
  // A tag there is no name for: the stream's name, else the tag. A tag that
  // is a name the table knows is that language.
  assert.deepEqual(
    audioLabels([{ lang: 'qaa', name: 'Klingon' }, { lang: 'qaa' }, { lang: 'German', name: 'Commentary' }]),
    ['Klingon', 'qaa', 'German'],
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
