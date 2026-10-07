// node --test (type stripping, Node >= 22.18): subtitle labels, the default
// track, the track list and the cue parser behind the player's overlay.
// Excluded from the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoSubtitle,
  buildSubtitleTracks,
  cueTextAt,
  languageName,
  normalizeLanguage,
  parseSubtitleCues,
  pickDefaultSubtitle,
  pickForcedSubtitle,
  playingAudioLanguage,
  saysForced,
  subtitleForAudio,
  subtitleLabels,
  type SubtitleChoice,
} from './subtitles.ts';

test('a language tag in any of its forms is one code', () => {
  assert.equal(normalizeLanguage('eng'), 'en');
  assert.equal(normalizeLanguage('EN'), 'en');
  assert.equal(normalizeLanguage('en-US'), 'en');
  assert.equal(normalizeLanguage('ger'), 'de');
  assert.equal(normalizeLanguage('deu'), 'de');
  assert.equal(normalizeLanguage('fre'), 'fr');
  assert.equal(normalizeLanguage('pt_BR'), 'pt');
  assert.equal(normalizeLanguage('English'), 'en');
  assert.equal(normalizeLanguage('und'), '');
  assert.equal(normalizeLanguage(''), '');
  assert.equal(normalizeLanguage(undefined), '');
});

test('tracks are labelled by language name', () => {
  assert.deepEqual(
    subtitleLabels([{ lang: 'en' }, { lang: 'ger' }, { lang: 'fra' }, { lang: 'ja' }, { lang: 'pt-BR' }]),
    ['English', 'German', 'French', 'Japanese', 'Portuguese'],
  );
  assert.equal(languageName('nob'), 'Norwegian Bokmål');
  assert.equal(languageName('und'), '');
});

test('a server label that only repeats the language, or says "Subtitles", adds nothing', () => {
  assert.deepEqual(
    subtitleLabels([
      { lang: 'en', title: 'English' },
      { lang: 'de', title: 'Subtitles' },
      { lang: 'fr', title: 'fre' },
      { lang: 'es', title: '(Spanish)' },
      { lang: 'it', title: 'it-IT' },
    ]),
    ['English', 'German', 'French', 'Spanish', 'Italian'],
  );
});

test('what a server label adds is kept beside the language', () => {
  assert.deepEqual(
    subtitleLabels([
      { lang: 'en', title: 'English (SDH)' },
      { lang: 'en', title: 'English - Commentary' },
      { lang: 'de', title: 'Kommentar (Regie)' },
    ]),
    ['English (SDH)', 'English (Commentary)', 'German (Kommentar (Regie))'],
  );
});

test('a forced track says so, once', () => {
  assert.deepEqual(
    subtitleLabels([
      { lang: 'en', forced: true },
      { lang: 'en', title: 'Forced', forced: true },
      { lang: 'en', title: 'English (SDH)', forced: true },
    ]),
    ['English (Forced)', 'English (Forced) 2', 'English (SDH, Forced)'],
  );
});

test('a track without a language goes by its own name, else Unknown', () => {
  assert.deepEqual(
    subtitleLabels([{ title: 'Signs & Songs' }, {}, { lang: 'und', title: 'Subtitles' }, { forced: true }, { lang: 'und', title: 'und' }]),
    ['Signs & Songs', 'Unknown', 'Unknown 2', 'Unknown (Forced)', 'Unknown 3'],
  );
});

test('mul is "Multiple languages", mis "Other language" - and neither a language to follow', () => {
  assert.equal(languageName('mul'), 'Multiple languages');
  assert.equal(languageName('MUL'), 'Multiple languages');
  assert.equal(languageName('mis'), 'Other language');
  assert.equal(normalizeLanguage('mul'), '');
  assert.equal(normalizeLanguage('mis'), '');
  assert.deepEqual(
    subtitleLabels([{ lang: 'mul' }, { lang: 'mis', title: 'Signs' }, { lang: 'mul', title: 'mul' }]),
    ['Multiple languages', 'Other language (Signs)', 'Multiple languages 2'],
  );
});

test('zxx, no linguistic content, is "No dialogue" - and still no language to follow', () => {
  for (const tag of ['zxx', 'ZXX', ' zxx ', 'zxx-Latn']) assert.equal(languageName(tag), 'No dialogue', tag);
  assert.equal(normalizeLanguage('zxx'), '');
  assert.deepEqual(
    subtitleLabels([{ lang: 'zxx' }, { lang: 'zxx', title: 'Signs' }, { lang: 'zxx', title: 'zxx' }]),
    ['No dialogue', 'No dialogue (Signs)', 'No dialogue 2'],
  );
});

test('two tracks that would read the same are numbered', () => {
  assert.deepEqual(
    subtitleLabels([{ lang: 'en' }, { lang: 'eng' }, { lang: 'de' }, { lang: 'en', title: 'English' }]),
    ['English', 'English 2', 'German', 'English 3'],
  );
});

const track = (id: string, lang: string, extra: Record<string, unknown> = {}) => ({
  id,
  lang,
  label: id,
  url: `https://h/api/v1/play/subs/${id}.vtt`,
  ...extra,
});

test('subtitles are off by default when the audio is in the preferred language', () => {
  const tracks = [track('en', 'en'), track('de', 'de')];
  assert.equal(pickDefaultSubtitle(tracks, { audioLang: 'eng', preferredLang: 'en' }), null);
});

test('subtitles in the preferred language come on when the audio is in another', () => {
  const tracks = [track('de', 'de'), track('en-forced', 'en', { forced: true }), track('en', 'en')];
  assert.equal(pickDefaultSubtitle(tracks, { audioLang: 'jpn', preferredLang: 'en' }), 'en');
});

test('no preference, unknown audio, or no full track in the language: off', () => {
  const tracks = [track('en', 'en', { default: true }), track('en-forced', 'en', { forced: true })];
  assert.equal(pickDefaultSubtitle(tracks, { audioLang: 'jpn' }), null);
  assert.equal(pickDefaultSubtitle(tracks, { audioLang: '', preferredLang: 'en' }), null);
  assert.equal(pickDefaultSubtitle(tracks, { audioLang: 'und', preferredLang: 'en' }), null);
  assert.equal(pickDefaultSubtitle([tracks[1]], { audioLang: 'jpn', preferredLang: 'en' }), null);
  // A track the server marks default is not switched on by that alone.
  assert.equal(pickDefaultSubtitle(tracks, { audioLang: 'jpn', preferredLang: 'fr' }), null);
});

// A title's tracks: full and forced ones in English and German, a forced
// PGS one in English first.
const titleTracks = [
  track('en-forced-pgs', 'en', { forced: true, format: 'pgs' }),
  track('en', 'en', { format: 'webvtt' }),
  track('en-forced', 'en', { forced: true, format: 'webvtt' }),
  track('de-forced', 'de', { forced: true, format: 'srt' }),
  track('de', 'de', { format: 'webvtt' }),
];

test("the audio in the viewer's language: the forced track in it comes on", () => {
  assert.equal(autoSubtitle(titleTracks, { audioLang: 'eng', preferredLang: 'en' }), 'en-forced');
  assert.equal(autoSubtitle(titleTracks, { audioLang: 'ger', preferredLang: 'de' }), 'de-forced');
  // No full track in the viewer's language either: the forced one in the
  // audio's.
  assert.equal(autoSubtitle(titleTracks, { audioLang: 'de', preferredLang: 'fr' }), 'de-forced');
});

test('no subtitle language set (Off in Settings): the forced track still comes on', () => {
  assert.equal(autoSubtitle(titleTracks, { audioLang: 'de' }), 'de-forced');
  assert.equal(autoSubtitle(titleTracks, { audioLang: 'en-US', preferredLang: '' }), 'en-forced');
});

test("audio in another language than the viewer's: the full track, not a forced one", () => {
  assert.equal(autoSubtitle(titleTracks, { audioLang: 'de', preferredLang: 'en' }), 'en');
  assert.equal(autoSubtitle(titleTracks, { audioLang: 'eng', preferredLang: 'de' }), 'de');
});

test('text before an image: a forced PGS track only where no forced text one is', () => {
  assert.equal(pickForcedSubtitle(titleTracks, 'en'), 'en-forced');
  assert.equal(pickForcedSubtitle([titleTracks[0]], 'en'), 'en-forced-pgs');
  assert.equal(pickForcedSubtitle([titleTracks[3]], 'de'), 'de-forced', 'SRT is text');
});

test("none: no forced track in the audio's language, or the audio's language not known", () => {
  assert.equal(pickForcedSubtitle(titleTracks, 'fr'), null);
  for (const lang of ['und', 'zxx', '', undefined]) assert.equal(pickForcedSubtitle(titleTracks, lang), null, String(lang));
  // A forced track is the audio's language's, not the viewer's.
  const englishForced = [track('en-forced', 'en', { forced: true })];
  assert.equal(autoSubtitle(englishForced, { audioLang: 'ja', preferredLang: 'en' }), null);
  assert.equal(autoSubtitle([track('en', 'en'), track('de', 'de')], { audioLang: 'en', preferredLang: 'en' }), null);
});

test("the rules' subtitle follows the audio from one language to the next", () => {
  const follow = (c: SubtitleChoice, audioLang: string, preferredLang?: string) =>
    subtitleForAudio(c, titleTracks, { audioLang, preferredLang });
  let c: SubtitleChoice = { id: autoSubtitle(titleTracks, { audioLang: 'en' }), picked: false };
  assert.equal(c.id, 'en-forced');
  c = follow(c, 'de');
  assert.deepEqual(c, { id: 'de-forced', picked: false });
  c = follow(c, 'fr');
  assert.deepEqual(c, { id: null, picked: false }, 'none in French');
  c = follow(c, 'eng');
  assert.deepEqual(c, { id: 'en-forced', picked: false });
  assert.equal(follow(c, 'en'), c, 'the same language: the same choice');
  // With a subtitle language: the full track while the audio is another's.
  c = follow(c, 'de', 'en');
  assert.deepEqual(c, { id: 'en', picked: false });
  c = follow(c, 'en', 'en');
  assert.deepEqual(c, { id: 'en-forced', picked: false });
});

test("the viewer's pick stays for the session, Off as well, whatever the audio", () => {
  const off: SubtitleChoice = { id: null, picked: true };
  assert.equal(subtitleForAudio(off, titleTracks, { audioLang: 'de' }), off);
  assert.equal(subtitleForAudio(off, titleTracks, { audioLang: 'en', preferredLang: 'en' }), off);
  const german: SubtitleChoice = { id: 'de', picked: true };
  assert.equal(subtitleForAudio(german, titleTracks, { audioLang: 'en', preferredLang: 'en' }), german);
});

test('audio whose language is not known changes nothing', () => {
  const c: SubtitleChoice = { id: 'en-forced', picked: false };
  for (const lang of ['und', 'mul', '']) assert.equal(subtitleForAudio(c, titleTracks, { audioLang: lang }), c, lang);
});

test('a sidecar the server calls forced is forced, by its flag or its label', () => {
  const tracks = buildSubtitleTracks({
    itemId: 'm1',
    sidecars: [
      { id: 'a', lang: 'en', label: 'Forced' },
      { id: 'b', lang: 'en', label: 'English (Forced)' },
      { id: 'c', lang: 'en', label: 'eng.forced' },
      { id: 'd', lang: 'en', label: 'Non-forced' },
      { id: 'e', lang: 'en', label: 'English' },
      { id: 'f', lang: 'de', label: 'Deutsch', forced: true },
    ],
    embedded: [],
    resolve: (path) => path,
    pgs: false,
  });
  assert.deepEqual(
    tracks.map((t) => [t.id, t.forced]),
    [['a', true], ['b', true], ['c', true], ['d', false], ['e', false], ['f', true]],
  );
  assert.deepEqual(tracks.slice(0, 2).map((t) => t.label), ['English (Forced)', 'English (Forced) 2']);
  // A sidecar labelled Forced is no full subtitle for a foreign soundtrack.
  assert.equal(pickDefaultSubtitle(tracks, { audioLang: 'ja', preferredLang: 'en' }), 'd');
  assert.equal(autoSubtitle(tracks, { audioLang: 'de' }), 'f');
  for (const label of ['SDH Forced', 'forced narrative']) assert.equal(saysForced(label), true, label);
  for (const label of ['not forced', 'Unforced', 'Reinforced', 'English', '', undefined]) {
    assert.equal(saysForced(label), false, String(label));
  }
});

test('the playing audio is the default track, else the first', () => {
  assert.equal(playingAudioLanguage([{ language: 'eng' }, { language: 'jpn', default: true }]), 'ja');
  assert.equal(playingAudioLanguage([{ language: 'deu' }, { language: 'eng' }]), 'de');
  assert.equal(playingAudioLanguage([]), '');
  assert.equal(playingAudioLanguage(undefined), '');
});

test('the track list: sidecars, then embedded text streams, each loadable', () => {
  const tracks = buildSubtitleTracks({
    itemId: 'm1',
    sidecars: [
      { id: 's1', lang: 'en', label: 'English', format: 'webvtt', url: '/api/v1/play/subs/s1.vtt' },
      { id: 's2', lang: 'de', label: 'German', format: 'srt', url: '/api/v1/play/subs/s2.vtt' },
      { id: 's3', lang: 'fr', label: 'French', format: 'pgs', url: '/api/v1/play/subs/s3.vtt' },
      { id: 's4', lang: 'it', label: 'Italian', format: 'vobsub' },
      { id: 's5', lang: 'es' },
    ],
    embedded: [
      { index: 0, codec: 'subrip', language: 'jpn', title: 'Japanese', forced: true },
      { index: 1, codec: 'hdmv_pgs_subtitle', language: 'eng' },
      { codec: 'webvtt', language: 'eng' }, // a packaged row: no stream index
    ],
    resolve: (path) => `https://h/api${path.slice(4)}?stream=t`,
    pgs: false,
  });
  assert.deepEqual(
    tracks.map((t) => [t.id, t.label, t.format, t.url]),
    [
      ['s1', 'English', 'webvtt', 'https://h/api/v1/play/subs/s1.vtt?stream=t'],
      ['s2', 'German', 'srt', 'https://h/api/v1/play/subs/s2.vtt?stream=t'],
      ['s5', 'Spanish', 'webvtt', 'https://h/api/v1/play/subs/s5.vtt?stream=t'],
      ['emb-0', 'Japanese (Forced)', 'webvtt', 'https://h/api/v1/items/m1/play/subtitles/0.vtt?stream=t'],
    ],
  );
  assert.equal(tracks[3].forced, true);
});

test('PGS is offered only where the engine can draw it', () => {
  const tracks = buildSubtitleTracks({
    itemId: 'm1',
    sidecars: [{ id: 's3', lang: 'fr', format: 'pgs', url: '/api/v1/play/subs/s3.vtt' }],
    embedded: [],
    resolve: (path) => path,
    pgs: true,
  });
  assert.deepEqual(tracks.map((t) => [t.id, t.label, t.format]), [['s3', 'French', 'pgs']]);
});

test('WebVTT: header, ids, cue settings, markup and entities', () => {
  const vtt = [
    '﻿WEBVTT',
    'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000',
    '',
    'NOTE a comment',
    '',
    'intro-1',
    '00:00:01.000 --> 00:00:03.500 line:85% align:center',
    '<v Joe><i>Hello</i> &amp; welcome</v>',
    '',
    '01:02.250 --> 01:04.000',
    '<c.yellow>Two</c>',
    'lines &lt;3',
    '',
  ].join('\n');
  assert.deepEqual(parseSubtitleCues(vtt), [
    { start: 1, end: 3.5, text: 'Hello & welcome' },
    { start: 62.25, end: 64, text: 'Two\nlines <3' },
  ]);
});

test('SRT: counters, comma decimals, CRLF, override tags, a missing blank line', () => {
  const srt = [
    '1',
    '00:00:05,000 --> 00:00:07,250',
    '{\\an8}<font color="#ffff00">Top</font>',
    '2',
    '00:00:08,000 --> 00:00:09,000',
    'Next',
    '',
    '3',
    '00:00:10,000 --> 00:00:10,000',
    'Zero length',
    '',
  ].join('\r\n');
  assert.deepEqual(parseSubtitleCues(srt), [
    { start: 5, end: 7.25, text: 'Top' },
    { start: 8, end: 9, text: 'Next' },
  ]);
});

test('the text on screen: covering cues in order, end exclusive', () => {
  const cues = parseSubtitleCues(
    ['WEBVTT', '', '00:00:01.000 --> 00:00:05.000', 'A', '', '00:00:02.000 --> 00:00:03.000', 'B', ''].join('\n'),
  );
  assert.equal(cueTextAt(cues, 0.5), '');
  assert.equal(cueTextAt(cues, 1), 'A');
  assert.equal(cueTextAt(cues, 2.5), 'A\nB');
  assert.equal(cueTextAt(cues, 3), 'A');
  assert.equal(cueTextAt(cues, 5), '');
});
