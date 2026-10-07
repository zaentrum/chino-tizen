// Subtitles as the player offers them. The tracks are the ones chino-web
// offers: chino-api's sidecar list (GET /items/{id}/subtitles, each with a
// /api/v1/play/subs/{id}.vtt url) and the embedded text streams /play/info
// reports (served as WebVTT by /items/{id}/play/subtitles/{index}.vtt). They
// are labelled by language name; a full one is on by default only when the
// audio is not in the viewer's language, else the forced one in the audio's
// language where there is one, following the audio as it changes until the
// viewer picks; and their cue files — WebVTT, or SRT (a .srt sidecar is
// served as SRT even at its .vtt url) — are parsed here for the player's own
// overlay. Pure: subtitles.test.ts runs it under node --test.

import type { PlayerSubtitle } from '../player/types';

/* ───────────────────────────────  Languages  ──────────────────────────────── */

// [ISO 639-1 (or the 639-2 code where there is no 639-1), English name,
// aliases: the 639-2/T and /B codes, older codes, native names]. Tracks arrive
// tagged every way: 639-1 from a sidecar's file name ("movie.de.srt"), 639-2
// from ffprobe and the packager, and the settings store 639-1.
const LANGUAGES: [string, string, ...string[]][] = [
  ['en', 'English', 'eng'],
  ['de', 'German', 'deu', 'ger', 'deutsch'],
  ['fr', 'French', 'fra', 'fre', 'français', 'francais'],
  ['es', 'Spanish', 'spa', 'español', 'espanol', 'castellano'],
  ['it', 'Italian', 'ita', 'italiano'],
  ['ja', 'Japanese', 'jpn'],
  ['pt', 'Portuguese', 'por', 'português', 'portugues'],
  ['nl', 'Dutch', 'nld', 'dut', 'nederlands', 'flemish'],
  ['zh', 'Chinese', 'zho', 'chi'],
  ['ru', 'Russian', 'rus'],
  ['pl', 'Polish', 'pol'],
  ['tr', 'Turkish', 'tur'],
  ['ko', 'Korean', 'kor'],
  ['ar', 'Arabic', 'ara'],
  ['hi', 'Hindi', 'hin'],
  ['cs', 'Czech', 'ces', 'cze'],
  ['sk', 'Slovak', 'slk', 'slo'],
  ['sv', 'Swedish', 'swe'],
  ['no', 'Norwegian', 'nor'],
  ['nb', 'Norwegian Bokmål', 'nob'],
  ['nn', 'Norwegian Nynorsk', 'nno'],
  ['da', 'Danish', 'dan'],
  ['fi', 'Finnish', 'fin'],
  ['is', 'Icelandic', 'isl', 'ice'],
  ['uk', 'Ukrainian', 'ukr'],
  ['ro', 'Romanian', 'ron', 'rum'],
  ['hu', 'Hungarian', 'hun'],
  ['el', 'Greek', 'ell', 'gre'],
  ['he', 'Hebrew', 'heb', 'iw'],
  ['th', 'Thai', 'tha'],
  ['vi', 'Vietnamese', 'vie'],
  ['id', 'Indonesian', 'ind', 'in'],
  ['ms', 'Malay', 'msa', 'may'],
  ['hr', 'Croatian', 'hrv'],
  ['sr', 'Serbian', 'srp'],
  ['bs', 'Bosnian', 'bos'],
  ['sl', 'Slovenian', 'slv'],
  ['bg', 'Bulgarian', 'bul'],
  ['mk', 'Macedonian', 'mkd', 'mac'],
  ['sq', 'Albanian', 'sqi', 'alb'],
  ['ca', 'Catalan', 'cat'],
  ['eu', 'Basque', 'eus', 'baq'],
  ['gl', 'Galician', 'glg'],
  ['et', 'Estonian', 'est'],
  ['lv', 'Latvian', 'lav'],
  ['lt', 'Lithuanian', 'lit'],
  ['ga', 'Irish', 'gle'],
  ['cy', 'Welsh', 'cym', 'wel'],
  ['fa', 'Persian', 'fas', 'per'],
  ['ur', 'Urdu', 'urd'],
  ['bn', 'Bengali', 'ben'],
  ['ta', 'Tamil', 'tam'],
  ['te', 'Telugu', 'tel'],
  ['tl', 'Tagalog', 'tgl'],
  ['af', 'Afrikaans', 'afr'],
  ['sw', 'Swahili', 'swa'],
  ['la', 'Latin', 'lat'],
  ['gsw', 'Swiss German'],
  ['fil', 'Filipino'],
];

interface Language {
  code: string;
  name: string;
}

const BY_TAG = new Map<string, Language>();
for (const [code, name, ...aliases] of LANGUAGES) {
  const lang = { code, name };
  for (const tag of [code, name, ...aliases]) BY_TAG.set(tag.toLowerCase(), lang);
}

/** Tags that say "no particular language". */
const UNDETERMINED = new Set(['und', 'mul', 'zxx', 'mis', 'unk', 'unknown', 'none', 'n/a']);

/** What a track tagged "zxx" (no linguistic content) is called: the audio of
 *  a film without dialogue. */
export const NO_DIALOGUE = 'No dialogue';

/** The tags for no one language that still say what a track is in, and what
 *  such a track is called: no dialogue ("zxx"), several languages ("mul"), a
 *  language ISO 639 has no code for ("mis"). */
const NOT_ONE_LANGUAGE = new Map([
  ['zxx', NO_DIALOGUE],
  ['mul', 'Multiple languages'],
  ['mis', 'Other language'],
]);

/** The tag's language subtag, lower-cased ("pt" of "PT_br"). */
function primarySubtag(tag: string | null | undefined): string {
  return (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
}

/** Is the tag "zxx": no linguistic content, no dialogue? */
export function isNoDialogue(tag: string | null | undefined): boolean {
  return primarySubtag(tag) === 'zxx';
}

/**
 * A language tag as one comparable code: the ISO 639-1 code where there is
 * one ("eng", "en-US", "English" → "en"), the primary subtag otherwise, ""
 * when it names no language ("und", nothing).
 */
export function normalizeLanguage(tag: string | null | undefined): string {
  const primary = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (!primary || UNDETERMINED.has(primary)) return '';
  return BY_TAG.get(primary)?.code ?? primary;
}

/**
 * The ISO 639-1 code of a language the text names outright — a code or a
 * name the table knows ("ger", "de-CH", "German", "Deutsch"), or a name
 * leading it ("German 5.1", "English (SDH)") — else "". Unlike
 * normalizeLanguage it passes no unknown word through: it reads a track's
 * label, which may say anything ("No commentary" is not Norwegian).
 */
export function knownLanguage(text: string | null | undefined): string {
  const t = (text ?? '').trim().toLowerCase();
  if (!t) return '';
  const whole = BY_TAG.get(t);
  if (whole) return whole.code;
  // A tag with a region or a script: "de-CH", "pt_BR".
  const tag = /^([a-z]{2,3})(?:[-_][a-z0-9]{2,8})+$/.exec(t);
  if (tag) return BY_TAG.get(tag[1])?.code ?? '';
  // A name first, then more: names only — two- and three-letter codes are
  // words too ("It", "In", "Ger…").
  const first = t.split(/[\s(·,:|–—-]+/)[0];
  return first.length >= 4 ? BY_TAG.get(first)?.code ?? '' : '';
}

/**
 * A language's English name ("de", "ger", "deu" → "German"); "No dialogue"
 * for "zxx", "Multiple languages" for "mul", "Other language" for "mis"; ""
 * when the tag names no language. A tag outside the table gets the
 * platform's name for it where the runtime has Intl.DisplayNames (newer TVs,
 * desktop), else the tag.
 */
export function languageName(tag: string | null | undefined): string {
  const notOne = NOT_ONE_LANGUAGE.get(primarySubtag(tag));
  if (notOne) return notOne;
  const code = normalizeLanguage(tag);
  if (!code) return '';
  const known = BY_TAG.get(code);
  if (known) return known.name;
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    const name = names.of(code);
    if (name && name.toLowerCase() !== code) return name;
  } catch {
    /* no Intl.DisplayNames on this runtime, or not a valid tag */
  }
  return (tag ?? '').trim();
}

/* ────────────────────────────────  Labels  ───────────────────────────────── */

export interface LabelInput {
  lang?: string;
  /** What the server calls the track: katalog's label, an embedded stream's title. */
  title?: string;
  forced?: boolean;
}

/** Server labels that say nothing about a track beyond "it is subtitles". */
const GENERIC_TITLES = new Set(['subtitles', 'subtitle', 'subs', 'sub', 'untitled', 'default', 'track', 'text']);

/** Does `text` only name the track's language again ("English", "eng",
 *  "en-US" for an English track)? */
function namesLanguage(text: string, lang: string, name: string): boolean {
  const lower = text.toLowerCase();
  if (name && lower === name.toLowerCase()) return true;
  if (!lang || normalizeLanguage(text) !== lang) return false;
  return BY_TAG.has(lower) || /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(text);
}

/** Does a server label say nothing about the track: "Subtitles", "Track",
 *  or a tag of no language ("und", "zxx")? */
function saysNothing(text: string): boolean {
  const lower = text.toLowerCase();
  return GENERIC_TITLES.has(lower) || UNDETERMINED.has(lower);
}

/** What a server label adds to the language name: "English (SDH)" → "SDH";
 *  nothing for "English", "eng", "Subtitles" or "und". */
export function qualifierOf(title: string | undefined, lang: string, name: string): string {
  let t = (title ?? '').trim();
  if (!t || saysNothing(t) || namesLanguage(t, lang, name)) return '';
  if (name && t.toLowerCase().indexOf(name.toLowerCase()) === 0) t = t.slice(name.length);
  t = t.replace(/^[\s\-–—:·,|]+/, '').trim();
  // Unwrap "(SDH)" / "[Forced]", or drop a closer whose opener went with the
  // language name ("English (SDH)" → "SDH)").
  if (/^\(.*\)$/.test(t) || /^\[.*\]$/.test(t)) t = t.slice(1, -1).trim();
  if (t.endsWith(')') && !t.includes('(')) t = t.slice(0, -1).trim();
  if (t.endsWith(']') && !t.includes('[')) t = t.slice(0, -1).trim();
  if (t.startsWith('(') && !t.includes(')')) t = t.slice(1).trim();
  if (t.startsWith('[') && !t.includes(']')) t = t.slice(1).trim();
  if (!t || saysNothing(t) || namesLanguage(t, lang, name)) return '';
  return t;
}

/** One track's label before duplicates are told apart. */
function baseLabel(track: LabelInput): string {
  const lang = normalizeLanguage(track.lang);
  const name = languageName(track.lang);
  const qualifier = qualifierOf(track.title, lang, name);
  const forced = !!track.forced && !/forced/i.test(qualifier);
  if (!name) {
    // No language: the server's own name for the track is the best there is.
    const own = qualifier || 'Unknown';
    return forced ? `${own} (Forced)` : own;
  }
  const extras = [qualifier, forced ? 'Forced' : ''].filter(Boolean);
  return extras.length ? `${name} (${extras.join(', ')})` : name;
}

/**
 * The labels a subtitle menu shows: the language by name — "English",
 * "German" — with what the server's label adds ("English (SDH)") and
 * "(Forced)" for a forced track. Two tracks that would read the same are
 * numbered: "English", "English 2".
 */
export function subtitleLabels(tracks: readonly LabelInput[]): string[] {
  const seen = new Map<string, number>();
  return tracks.map((t) => {
    const label = baseLabel(t);
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} ${n}`;
  });
}

/* ────────────────────────────────  Tracks  ───────────────────────────────── */

/** A sidecar from GET /items/{id}/subtitles (katalog's subtitle row). */
export interface SidecarSubtitle {
  id: string;
  lang?: string;
  label?: string;
  format?: string;
  default?: boolean;
  /** Covers only the lines in another language than the audio's. chino-api
   *  does not send it (katalog's rows have no such column); a label that
   *  says so counts (saysForced). */
  forced?: boolean;
  /** "/api/v1/play/subs/{id}.vtt", origin-relative. */
  url?: string;
}

/** Does a server label call its track forced — "Forced", "English
 *  (Forced)", "eng.forced" — and not "Non-forced"? The rule the packager
 *  reads a source's titles by. */
export function saysForced(label: string | null | undefined): boolean {
  const t = label ?? '';
  return /\bforced\b/i.test(t) && !/\b(non|not|no|un)[- ]?forced\b/i.test(t);
}

/** A subtitle stream /play/info lists in subtitle_tracks. ffprobe's rows for
 *  a source file carry the stream index the extractor addresses; a packaged
 *  title's rows carry none — its subtitles are the sidecars. */
export interface EmbeddedSubtitle {
  index?: number;
  codec?: string;
  language?: string;
  title?: string;
  default?: boolean;
  forced?: boolean;
}

const PGS_FORMATS = new Set(['pgs', 'sup', 'hdmv_pgs_subtitle', 'pgssub']);
const OTHER_BITMAP_FORMATS = new Set([
  'vobsub', 'dvd_subtitle', 'dvdsub', 'dvb', 'dvbsub', 'dvb_subtitle', 'xsub',
]);

/** How a subtitle format can be shown: as text (WebVTT/SRT, drawn by the
 *  player's overlay), as PGS (only where the engine has a renderer), or not. */
export function subtitleKind(format: string | undefined): 'text' | 'pgs' | 'none' {
  const f = (format ?? '').trim().toLowerCase();
  if (PGS_FORMATS.has(f)) return 'pgs';
  if (OTHER_BITMAP_FORMATS.has(f)) return 'none';
  return 'text';
}

/**
 * The selectable tracks, labelled: sidecars first, then the embedded text
 * streams, as chino-web merges them. Tracks the engine cannot show are left
 * out (bitmap formats; PGS unless `pgs`), as are embedded rows without a
 * stream index. `resolve` turns an asset path into a loadable URL (the API
 * base plus the stream token).
 */
export function buildSubtitleTracks(o: {
  itemId: string;
  sidecars: readonly SidecarSubtitle[];
  embedded: readonly EmbeddedSubtitle[];
  resolve: (path: string) => string;
  pgs: boolean;
}): PlayerSubtitle[] {
  const raw: (Omit<PlayerSubtitle, 'label'> & { title?: string })[] = [];
  for (const s of o.sidecars) {
    if (!s?.id) continue;
    const format = (s.format ?? '').trim().toLowerCase() || 'webvtt';
    const kind = subtitleKind(format);
    if (kind === 'none' || (kind === 'pgs' && !o.pgs)) continue;
    raw.push({
      id: s.id,
      lang: normalizeLanguage(s.lang),
      title: s.label,
      url: o.resolve(s.url || `/api/v1/play/subs/${encodeURIComponent(s.id)}.vtt`),
      format,
      default: !!s.default,
      forced: !!s.forced || saysForced(s.label),
    });
  }
  for (const t of o.embedded) {
    if (t?.index == null || !Number.isInteger(t.index) || t.index < 0) continue;
    if (subtitleKind(t.codec) !== 'text') continue; // ffmpeg cannot turn a bitmap into WebVTT
    raw.push({
      id: `emb-${t.index}`,
      lang: normalizeLanguage(t.language),
      title: t.title,
      url: o.resolve(`/api/v1/items/${encodeURIComponent(o.itemId)}/play/subtitles/${t.index}.vtt`),
      format: 'webvtt',
      default: !!t.default,
      forced: !!t.forced,
    });
  }
  const labels = subtitleLabels(raw.map((r) => ({ lang: r.lang, title: r.title, forced: r.forced })));
  return raw.map(({ title: _title, ...track }, i) => ({ ...track, label: labels[i] }));
}

/** An audio track as /play/info lists it (audio_tracks). */
export interface AudioTrackInfo {
  language?: string;
  default?: boolean;
}

/** The language of the audio that plays: the preferred one (Settings →
 *  Audio) when a track is in it — the player switches to that track — else
 *  the default track's, else the first's; "" when unknown. */
export function playingAudioLanguage(
  tracks: readonly AudioTrackInfo[] | null | undefined,
  preferred?: string | null,
): string {
  const list = tracks ?? [];
  const want = normalizeLanguage(preferred);
  if (want && list.some((t) => normalizeLanguage(t?.language) === want)) return want;
  const playing = list.find((t) => t?.default) ?? list[0];
  return normalizeLanguage(playing?.language);
}

/**
 * The full subtitle on by default, or null for none. None unless the audio is
 * in another language than the viewer's: with a preferred language set and
 * audio known to be in a different one, the first full (not forced) track in
 * the preferred language. A forced track only covers foreign-language lines
 * of the original audio, so it is no subtitle for a whole foreign soundtrack
 * (where none comes on, autoSubtitle puts the forced one on). A server's
 * "default" flag is not followed: a foreign track marked default would
 * otherwise switch itself on.
 */
export function pickDefaultSubtitle(
  tracks: readonly PlayerSubtitle[],
  o: { audioLang?: string; preferredLang?: string },
): string | null {
  const wanted = normalizeLanguage(o.preferredLang);
  if (!wanted) return null;
  const audio = normalizeLanguage(o.audioLang);
  if (!audio || audio === wanted) return null;
  const match = tracks.find((t) => normalizeLanguage(t.lang) === wanted && !t.forced);
  return match ? match.id : null;
}

/**
 * The forced track for audio in `audioLang`, or null: a forced track carries
 * the lines the audio leaves in another language (a sign, a few words in
 * another tongue), in the audio's own language, so it is the one in the
 * language of the audio — of several, text before an image format (PGS),
 * else the first. Null when the audio's language is not known, or no
 * forced track is in it.
 */
export function pickForcedSubtitle(
  tracks: readonly PlayerSubtitle[],
  audioLang: string | null | undefined,
): string | null {
  const audio = normalizeLanguage(audioLang);
  if (!audio) return null;
  const forced = tracks.filter((t) => t.forced && normalizeLanguage(t.lang) === audio);
  return (forced.find((t) => subtitleKind(t.format) === 'text') ?? forced[0])?.id ?? null;
}

/**
 * The subtitle on by itself, or null for off: the full track in the viewer's
 * language when the audio is in another (pickDefaultSubtitle); where that
 * puts none on — the audio in the viewer's language, no subtitle language
 * set, no full track in it — the forced track in the audio's language
 * (pickForcedSubtitle).
 */
export function autoSubtitle(
  tracks: readonly PlayerSubtitle[],
  o: { audioLang?: string; preferredLang?: string },
): string | null {
  return pickDefaultSubtitle(tracks, o) ?? pickForcedSubtitle(tracks, o.audioLang);
}

/** The subtitle on screen, and who chose it. */
export interface SubtitleChoice {
  /** The track on screen; null for off. */
  id: string | null;
  /** The viewer picked it in the menu, Off as well: it stays for the
   *  session. Else the rules chose it (autoSubtitle), and it follows the
   *  audio. */
  picked: boolean;
}

/**
 * The subtitle once the audio plays in `audioLang` — the language of the
 * track the engine plays, again whenever another one plays: the rules'
 * choice for that language (autoSubtitle), so a forced track follows the
 * audio from one language to the next. One the viewer picked, a track or
 * Off, stays, whatever the audio; audio whose language is not known changes
 * nothing. The same choice, not a copy, when nothing changes.
 */
export function subtitleForAudio(
  choice: SubtitleChoice,
  tracks: readonly PlayerSubtitle[],
  o: { audioLang?: string; preferredLang?: string },
): SubtitleChoice {
  if (choice.picked || !normalizeLanguage(o.audioLang)) return choice;
  const id = autoSubtitle(tracks, o);
  return id === choice.id ? choice : { id, picked: false };
}

/* ─────────────────────────────────  Cues  ────────────────────────────────── */

export interface Cue {
  /** Seconds. */
  start: number;
  /** Seconds, exclusive. */
  end: number;
  text: string;
}

// "00:01:02.500", "00:01:02,500" (SRT), "01:02.500" (WebVTT without hours),
// "00:01:02". Cue settings may follow the end ("line:85% align:center").
const TIMING =
  /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?)/;

function seconds(stamp: string): number {
  const [clock, fraction] = stamp.split(/[.,]/);
  let s = 0;
  for (const part of clock.split(':')) s = s * 60 + Number(part);
  return s + (fraction ? Number(`0.${fraction}`) : 0);
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

/** A cue's text as plain lines: markup (<i>, <c.yellow>, <v Joe>, <font>,
 *  inline timestamps) and SRT override tags ({\an8}) removed, entities decoded. */
function cueText(lines: string[]): string {
  const markupFree = lines.join('\n').replace(/\{\\[^}]*\}/g, '').replace(/<[^>\n]*>/g, '');
  return decodeEntities(markupFree)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Parse a WebVTT or SRT file into cues sorted by start. The WEBVTT header,
 * NOTE / STYLE / REGION blocks, cue identifiers and SRT counters are skipped;
 * a missing blank line between two SRT cues does not swallow the next one.
 */
export function parseSubtitleCues(text: string): Cue[] {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues: (Cue & { n: number })[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TIMING.exec(lines[i]);
    if (!m) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== '' && !TIMING.test(lines[j]); j++) {
      body.push(lines[j]);
    }
    // Ran into the next cue's timing: its SRT counter is the line before it.
    if (j < lines.length && TIMING.test(lines[j]) && /^\d+$/.test((body[body.length - 1] ?? '').trim())) {
      body.pop();
    }
    const start = seconds(m[1]);
    const end = seconds(m[2]);
    const t = cueText(body);
    if (t && end > start) cues.push({ start, end, text: t, n: cues.length });
    i = j - 1;
  }
  // The file order breaks ties, on runtimes whose sort is not stable too.
  cues.sort((a, b) => a.start - b.start || a.n - b.n);
  return cues.map(({ start, end, text: t }) => ({ start, end, text: t }));
}

/** The text on screen at `time` (seconds): every cue that covers it, in
 *  order, one per line; "" when none does. */
export function cueTextAt(cues: readonly Cue[], time: number): string {
  const shown: string[] = [];
  for (const c of cues) {
    if (c.start > time) break;
    if (time < c.end) shown.push(c.text);
  }
  return shown.join('\n');
}
