// Which audio track plays: the language Settings → Audio prefers, and the
// track picked in the player's menu — found again in every source the engine
// loads, since a quality switch reloads a master that starts on its DEFAULT
// audio. Tracks are matched by language across spellings ("de", "ger",
// "deu", "German", "Deutsch" are one — @/lib/subtitles' table, the
// counterpart of chino-web's lib/languages.ts), between two of one language
// by label, else by place, as chino-web's audioRenditionFor does. Pure:
// audio.test.ts runs it under node --test.

import { knownLanguage, languageName, normalizeLanguage } from './subtitles.ts';

/** An audio track as an engine lists it. */
export interface AudioOption {
  id: string;
  /** Its language tag as the stream gives it ("de", "ger"), if any. */
  lang?: string;
  /** What the menu shows. */
  label?: string;
  /** The track playing. */
  selected?: boolean;
}

/** The audio wanted: a language (the Settings preference), or the track
 *  picked — its language, its label and its place among the tracks. */
export interface AudioWant {
  lang?: string;
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
 *  - With a language: the track in it; of several, the one with the label
 *    wanted, else the one at the place wanted, else the one playing, else
 *    the first.
 *  - Without (a track picked that names none): the one with its label, else
 *    the one at its place.
 */
export function audioTrackFor(
  tracks: readonly AudioOption[],
  want: AudioWant | null | undefined,
): string | null {
  if (!want || tracks.length === 0) return null;
  const lang = normalizeLanguage(want.lang);
  const label = (want.label ?? '').trim().toLowerCase();
  const named = (t: AudioOption) => label !== '' && (t.label ?? '').trim().toLowerCase() === label;
  const atPlace = want.place != null && want.place >= 0 ? tracks[want.place] : undefined;
  let pick: AudioOption | undefined;
  if (lang) {
    const inLang = tracks.filter((t) => trackLanguage(t) === lang);
    pick =
      inLang.length <= 1
        ? inLang[0]
        : inLang.find(named) ??
          (atPlace && inLang.includes(atPlace) ? atPlace : undefined) ??
          inLang.find((t) => t.selected) ??
          inLang[0];
  } else {
    pick = tracks.find(named) ?? atPlace;
  }
  return pick && !pick.selected ? pick.id : null;
}

/** A channel count as menus name the layout; "" for stereo and less. */
function layout(channels: number | undefined): string {
  if (!channels || channels <= 2) return '';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels} ch`;
}

/**
 * What the audio menu calls each track: its own name where the stream gives
 * one, else its language by name with the layout when it is more than
 * stereo ("German 5.1"), else "Audio N". Two that would read the same are
 * numbered ("German 2").
 */
export function audioLabels(
  tracks: readonly { lang?: string; name?: string; channels?: number }[],
): string[] {
  const seen = new Map<string, number>();
  return tracks.map((t, i) => {
    const own = (t.name ?? '').trim();
    const language = languageName(t.lang);
    const base = own || (language ? [language, layout(t.channels)].filter(Boolean).join(' ') : `Audio ${i + 1}`);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} ${n}`;
  });
}
