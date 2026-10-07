// Which audio track plays: the language Settings → Audio prefers, and the
// track picked in the player's menu — found again in every source the engine
// loads, since a quality switch reloads a master that starts on its DEFAULT
// audio. Tracks are matched by language across spellings ("de", "ger",
// "deu", "German", "Deutsch" are one — @/lib/subtitles' table, the
// counterpart of chino-web's lib/languages.ts), between two of one language
// by name (the master's NAME, unique in its group), else by label, else by
// place, as chino-web's audioRenditionFor does. Two of one language are the
// rule for a client with eac3: chino-stream serves it one audio group, each
// 5.1 E-AC-3 companion just before its stereo twin ("English 5.1",
// "English"). Pure: audio.test.ts runs it under node --test.

import { knownLanguage, languageName, normalizeLanguage, qualifierOf } from './subtitles.ts';

/** An audio track as an engine lists it. */
export interface AudioOption {
  id: string;
  /** Its language tag as the stream gives it ("de", "ger"), if any. */
  lang?: string;
  /** Its name in the master (NAME), where the engine says. */
  name?: string;
  /** What the menu shows. */
  label?: string;
  /** The track playing. */
  selected?: boolean;
}

/** The audio wanted: a language (the Settings preference), or the track
 *  picked — its language, its name, its label and its place among the
 *  tracks. */
export interface AudioWant {
  lang?: string;
  name?: string;
  label?: string;
  place?: number;
}

/** A track's language: its tag's, else the one its label names ("Deutsch",
 *  "German 5.1"); "" when neither says. */
export function trackLanguage(t: { lang?: string; label?: string }): string {
  return normalizeLanguage(t.lang) || knownLanguage(t.label);
}

/**
 * The track to switch to so that the audio wanted plays, or null to leave
 * what plays — nothing wanted, no track in the language wanted, or the one
 * wanted is playing already.
 *  - With a language: the track in it; of several, the one with the name
 *    wanted, else the one with the label wanted, else the one at the place
 *    wanted, else the one playing, else the first — a 5.1 companion, first
 *    in its language, where there is one.
 *  - Without (a track picked that names none): the one with its name, else
 *    its label, else the one at its place.
 */
export function audioTrackFor(
  tracks: readonly AudioOption[],
  want: AudioWant | null | undefined,
): string | null {
  if (!want || tracks.length === 0) return null;
  const lang = normalizeLanguage(want.lang);
  const key = (s: string | undefined) => (s ?? '').trim().toLowerCase();
  const name = key(want.name);
  const label = key(want.label);
  const byName = (t: AudioOption) => name !== '' && key(t.name) === name;
  const named = (t: AudioOption) => label !== '' && key(t.label) === label;
  const atPlace = want.place != null && want.place >= 0 ? tracks[want.place] : undefined;
  let pick: AudioOption | undefined;
  if (lang) {
    const inLang = tracks.filter((t) => trackLanguage(t) === lang);
    pick =
      inLang.length <= 1
        ? inLang[0]
        : inLang.find(byName) ??
          inLang.find(named) ??
          (atPlace && inLang.includes(atPlace) ? atPlace : undefined) ??
          inLang.find((t) => t.selected) ??
          inLang[0];
  } else {
    pick = tracks.find(byName) ?? tracks.find(named) ?? atPlace;
  }
  return pick && !pick.selected ? pick.id : null;
}

/** What /play/info says of an audio track (audio_tracks). */
export interface InfoAudioTrack {
  language?: string;
  /** The master's NAME for it. */
  name?: string;
  title?: string;
  channels?: number;
  /** The GROUP-ID of its audio group: set where the list is the renditions
   *  of the one group the master serves, in the master's order. */
  group?: string;
}

/** What a track's label is made of (audioLabels). */
interface AudioFacts {
  lang?: string;
  name?: string;
  channels?: number;
  label: string;
}

/**
 * The engine's audio tracks with what /play/info says of them, where it lists
 * the renditions of the one group the master serves, in the master's order —
 * each with its group: chino-stream's list for a client with eac3, the stereo
 * tracks with the 5.1 companions among them. Each track takes its name (the
 * master's NAME, what a pick is found again by) and its channels from there,
 * its language where the engine has none, and its label from that: AVPlay
 * names no track and need not give the channels of one it has not played,
 * and "English 5.1" beside "English" read "English", "English 2". Only when
 * the two line up — as many tracks, none in another language or of another
 * channel count than the engine says — else, and for any other list (on the
 * fly a source's tracks give the source's channels, not the stream's), the
 * engine's tracks as they are.
 */
export function withPlayInfo<T extends AudioFacts>(
  tracks: readonly T[],
  info: readonly InfoAudioTrack[] | null | undefined,
): T[] {
  const rows = info ?? [];
  const differ = (a: string, b: string) => a !== '' && b !== '' && a !== b;
  const linedUp =
    rows.length > 0 &&
    rows.length === tracks.length &&
    rows.every((r, i) => {
      const t = tracks[i];
      return (
        !!r?.group &&
        !differ(normalizeLanguage(t.lang), normalizeLanguage(r.language)) &&
        !(t.channels && r.channels && t.channels !== r.channels)
      );
    });
  if (!linedUp) return [...tracks];
  const merged = tracks.map((t, i) => ({
    ...t,
    lang: t.lang || rows[i].language || undefined,
    name: (rows[i].name || rows[i].title || '').trim() || t.name,
    channels: rows[i].channels || t.channels,
  }));
  const labels = audioLabels(merged);
  return merged.map((t, i) => ({ ...t, label: labels[i] }));
}

/** A channel count as menus name the layout; "" for stereo and less. */
function layout(channels: number | undefined): string {
  if (!channels || channels <= 2) return '';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels} ch`;
}

// A name that describes the source's audio format - a codec, a bitrate, a
// sample rate or depth ("AC3 5.1 @ 640 Kbps", "DTS-HD MA 5.1") - and so
// nothing of the track: the stream is AAC whatever the file had. chino-web's
// lib/languages.ts.
const FORMAT_WORDS =
  /(^|[^a-z0-9])(dts(-hd)?|truehd|atmos|dolby|e?-?ac-?3|ddp?\+?|aac|flac|l?pcm|opus|mp3|vorbis|lossless|master audio|\d+ ?k?hz|\d* ?[km]bps|kb\/s|\d+[- ]?bit)(?![a-z0-9])/i;
// A channel layout in a name, which goes: the label names the layout itself.
const LAYOUT_WORDS = /(^|[^a-z0-9.])(mono|stereo|surround|[1-9]\.[0-2]|\d{1,2} ?ch(annels?)?)(?![a-z0-9.])/gi;
// A name that only numbers the track ("Track 2", "Audio Track 1", "2").
const NUMBERED = /^(audio|sound|track|stream|[\s#])*\d*$/i;

/** What a track's name says beyond its language ("Commentary 5.1" on an
 *  English track: "Commentary"); "" for nothing: a format, a number, the
 *  language again ("English", "eng", "Deutsch" on German), a tag of none. */
function nameOf(name: string | undefined, lang: string, language: string): string {
  const raw = (name ?? '').trim();
  if (!raw || FORMAT_WORDS.test(raw)) return '';
  const t = qualifierOf(
    raw
      .replace(LAYOUT_WORDS, '$1')
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—:·,|/]+|[\s\-–—:·,|/]+$/g, ''),
    lang,
    language,
  );
  return NUMBERED.test(t) ? '' : t;
}

/**
 * What the audio menu calls each track: its language by name - "No
 * dialogue" for zxx - with the layout when it is more than stereo ("German
 * 5.1"); a track in no language what its name says, else "Unknown". The
 * stream's name never stands in for the language: an old playlist's names
 * are free text ("AC3 5.1 @ 640 Kbps", "Track 0"). Two that would read the
 * same are told apart by what their names say ("English (Commentary)"),
 * else numbered ("German 2").
 */
export function audioLabels(
  tracks: readonly { lang?: string; name?: string; channels?: number }[],
): string[] {
  const parts = tracks.map((t) => {
    const lang = normalizeLanguage(t.lang);
    let language = languageName(t.lang);
    // A tag the table and the platform have no name for: the stream's name
    // for the track before the tag.
    const tag = (t.lang ?? '').trim();
    const named = language !== '' && (language !== tag || knownLanguage(tag) !== '');
    const own = nameOf(t.name, lang, named ? language : '');
    if (!named) language = own || language || 'Unknown';
    return { head: [language, layout(t.channels)].filter(Boolean).join(' '), own: named ? own : '' };
  });
  const count = new Map<string, number>();
  for (const p of parts) count.set(p.head, (count.get(p.head) ?? 0) + 1);
  const seen = new Map<string, number>();
  return parts.map((p) => {
    const label = (count.get(p.head) ?? 0) > 1 && p.own ? `${p.head} (${p.own})` : p.head;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} ${n}`;
  });
}
