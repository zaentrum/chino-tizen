// What the player asks chino-api for, by what it plays. One player plays
// everything (@/screens/PlayerScreen), with the same controls, track menus and
// remote keys: a title — a movie, an episode — or one of a title's extras (a
// trailer, a teaser, … @/lib/trailers).
//
// A title is the viewer's own: the player starts it where they left off and
// writes back where they got to, marks it watched, skips its intro and
// credits, shows its trickplay previews and plays the next episode. An extra
// is not: chino-api keeps nothing of it — no /play/info, progress, watched
// state, subtitles, segments, trickplay or next episode — so the player asks
// for none of them and writes nothing; an extra never shows up in Continue
// watching. It starts at the head, with sound, and its end goes back to the
// title. (Neither mode asks for a prewarm: this app never does. Nor does it
// send telemetry.) Pure: playMode.test.ts runs it under node --test.

/** What the player plays: a title, or one of a title's extras. */
export type PlayMode = 'title' | 'extra';

/** What the player asks for, and does, in a mode. Besides these it always
 *  asks for the title (GET /items/{id}) and a stream token. */
export interface PlayPlan {
  /** GET /items/{id}/play/info?caps= — the Quality menu's entries, the
   *  tracks, the runtime. */
  playInfo: boolean;
  /** GET /items/{id}/progress, to start where the viewer left off (or where
   *  Start over or a Zap hand-off says), and POST it back while playing and
   *  on the way out — what Continue watching is made of. Else the head. */
  progress: boolean;
  /** POST /me/items/{id}/watched at the credits, or at 95 %. */
  watched: boolean;
  /** GET /items/{id}/subtitles, and the embedded tracks /play/info lists:
   *  the Subtitles menu. */
  subtitles: boolean;
  /** GET /items/{id}/segments — Skip intro / credits and their countdown. */
  segments: boolean;
  /** The trickplay previews over the scrub bar (/play/trickplay/). */
  trickplay: boolean;
  /** GET /series/{id}/next-episode — Next episode, and the next one played
   *  at the end. */
  nextEpisode: boolean;
  /** The master asked for once before the engine gets it. AVPlay does not
   *  say why a master did not open; asked first, one that is not there (400,
   *  404, 410) says so (@/lib/trailers' trailerFailure). */
  checkMaster: boolean;
  /** Told to play once loaded: AVPlay plays once it is prepared, the hls.js
   *  engine when told. */
  playOnLoad: boolean;
}

/**
 * What the player asks for, and does, in `mode`. A title: all a title has, as
 * the player always asked. An extra: none of it, its master checked first and
 * played once loaded. A mode not known is asked for nothing of a title's.
 */
export function playPlan(mode: PlayMode): PlayPlan {
  const title = mode === 'title';
  return {
    playInfo: title,
    progress: title,
    watched: title,
    subtitles: title,
    segments: title,
    trickplay: title,
    nextEpisode: title,
    checkMaster: !title,
    playOnLoad: !title,
  };
}

/** The player's title bar for an extra: "<Title> · <extra>"; either alone
 *  when the other is missing. */
export function extraHeading(
  title: string | null | undefined,
  extraTitle: string | null | undefined,
): string {
  const t = (title ?? '').trim();
  const x = (extraTitle ?? '').trim();
  return t && x ? `${t} · ${x}` : t || x;
}
