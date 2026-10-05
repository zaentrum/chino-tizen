// chino-api wire types. These mirror the JSON chino-api returns (snake_case
// on the wire) so the client layer can hand React components plain objects
// with no re-mapping. Field-by-field authority:
//   - katalog Item projection  → chino-api/internal/katalog/client.go (Item)
//   - segments                 → chino-api/internal/http/series.go + katalog Segment
//   - people                   → chino-api/internal/http/people.go + katalog Person
//   - /api/config              → chino-api/internal/http/appconfig.go
//   - /play/info qualities     → chino-stream/internal/play/handler.go
//
// We follow chino-web's hook types (useItems / useItem / usePeople /
// useWatchlists) for the shapes the UI actually consumes, and keep the
// extra fields chino-web carries (watched_at, and series_title +
// position/duration on continue-watching rows) so screens have the same
// data the reference client does. No sort_title: chino-api does not pass it
// on.

/**
 * A cast or crew credit on an item, as katalog-api sends it
 * (chino-api/internal/katalog/client.go CastEntry): role by role, and within a
 * role in billing order. `person_id` deep-links to /people/{id}.
 */
export interface CastEntry {
  // katalog-api carries the catalogue person id on each credit so the
  // detail page can link the name to the Person surface. Absent for
  // un-linked credits — the UI skips the link in that case.
  person_id?: string;
  name: string;
  /** An open token: actor, creator, director, writer, producer, composer,
   *  cinematographer, editor, or any other (@/lib/credits names them). Empty
   *  — or absent, from catalogs older than roles — is an actor. */
  role?: string;
  /** The job within the role ("Screenplay"). */
  job?: string;
  /** The part an actor plays. */
  character?: string;
  /** Billing order within the role, 0 first. */
  order?: number;
  /** How many episodes of a series the credit covers. */
  episode_count?: number;
}

/** A selectable subtitle track. `url` is synthesised by chino-api's
 *  subtitles handler pointing at /api/v1/play/subs/{id}.vtt. */
export interface Subtitle {
  id: string;
  lang?: string;
  label?: string;
  // webvtt/srt route through a native <track>/AVPlay subtitle; pgs goes
  // through libpgs's canvas overlay. Missing means a text track.
  format?: string;
  default?: boolean;
  // Synthesised playback URL (only present on the /subtitles list response).
  url?: string;
}

/** A link to a trailer online (TMDB-sourced). chino-api always sends `url`:
 *  a trailer this server plays is an ExtraRef in `extras`, never one of these. */
export interface Trailer {
  site?: string;
  external_id?: string;
  url: string;
  title?: string;
}

/**
 * One of a title's extras that plays from this server, as GET /items/{id}
 * lists them in `extras` (absent when none plays; chino-api/internal/katalog/
 * client.go Extra): a trailer, a teaser, a featurette, … packaged for
 * streaming apart from the title, in the order a viewer sees them.
 * `play_path` is its HLS master, origin-relative like a poster's
 * ("/api/v1/items/{id}/extras/{extraId}/play/master.m3u8"; resolve it with
 * api.assetUrl), asked for as a title's master is (?stream=, &caps=). An
 * extra has no progress, watched state, segments, trickplay, /play/info or
 * /prewarm.
 */
export interface ExtraRef {
  id: string;
  /** trailer, teaser, featurette, behind-the-scenes, making-of,
   *  deleted-scene, interview, gag-reel, short or other. */
  kind: string;
  title: string;
  /** BCP 47 ("en"), when known. */
  language?: string;
  duration_ms?: number;
  /** Set on a series' extra of one season (0 the specials). */
  season_number?: number;
  /** Always true: an extra plays from this server. */
  local: boolean;
  play_path: string;
}

/** Per-item summary of analyzer-detected segments — drives whether the
 *  detail/player surfaces a "Skip Intro / Credits" affordance at all. */
export interface SegSummary {
  count: number;
  has_intro: boolean;
  has_credits: boolean;
  has_recap: boolean;
}

/**
 * A catalogue entry. Browse lists carry the lean fields (id/title/year/…);
 * GetItemDetail (`/items/{id}`) additionally populates the rich
 * associations (genres/cast/subtitles/trailers/extras/segments).
 */
export interface Item {
  id: string;
  type: string;
  title: string;
  year?: number;
  rating?: number;
  description?: string;
  tagline?: string;
  duration_ms?: number;

  // Episode coordinates — only set for type === 'episode'.
  season_number?: number;
  episode_number?: number;
  parent_id?: string;

  genres?: string[];
  cast?: CastEntry[];
  subtitles?: Subtitle[];
  trailers?: Trailer[];
  extras?: ExtraRef[];
  segments?: SegSummary;

  poster_url?: string;
  backdrop_url?: string;

  // chino-api stamps `watched_at` (ISO timestamp, or null) per user — the
  // presence of a non-null value is the "Watched" signal. `watched` is the
  // contract's convenience boolean; the client derives it from watched_at.
  watched_at?: string | null;
  watched?: boolean;
}

/**
 * A row of GET /me/continue-watching: an Item plus the user's saved position
 * (chino-api/internal/http/continue_watching.go). Only this feed carries a
 * position — GET /items/{id} does not; the player reads GET
 * /items/{id}/progress. `duration_sec` is the timeline length the player
 * reported (0 when it never did); `up_next` marks a next-episode card the
 * server substituted for a finished one (position 0, nothing to resume).
 */
export interface ContinueWatchingItem extends Item {
  position_sec: number;
  duration_sec: number;
  series_title?: string;
  up_next?: boolean;
}

/** One season of GET /series/{id}/episodes — episodes are full Items with the
 *  user's watched_at stamped. Season 0 holds the specials (and episodes
 *  without coordinates); it sorts first on the wire (the episode list shows
 *  it last, @/lib/seasons). */
export interface Season {
  season: number;
  episodes: Item[];
}

/**
 * GET /series/{id}/next-episode[?after=]. Wire: { next: Item | null,
 * anchor?, reason? }. With ?after= the episode after that one; without it the
 * one after the series' last-touched episode (`anchor`), or the first episode
 * when there is none. `next` is null at the end of the series
 * (reason "end_of_series").
 */
export interface NextEpisode {
  next: Item | null;
  anchor?: string;
  reason?: string;
}

/** One analyzer-detected segment (intro/credits/recap) in millisecond
 *  bounds. Returned by GET /items/{id}/segments. */
export interface Segment {
  id: string;
  kind: string;
  start_ms: number;
  end_ms: number;
}

/** An audio or subtitle track as GET /items/{id}/play/info lists it. A source
 *  file's rows come from ffprobe and carry the per-kind stream `index` (what
 *  /play/subtitles/{index}.vtt extracts); a packaged title's rows come from its
 *  manifest (audio: the renditions; subtitles: the sidecar files, no index).
 *  Languages are ISO 639-2 ("eng"), "und" when untagged. */
export interface PlayInfoTrack {
  index?: number;
  codec?: string;
  language?: string;
  title?: string;
  default?: boolean;
  forced?: boolean;
  channels?: number;
}

/** Result of GET /items/{id}/play/info — the server's decision for this
 *  client's caps plus the qualities it may pick (@/lib/qualities). */
export interface PlayInfo {
  duration_ms: number;
  /** What a quality pick may ask for ({ name, label, … } on the wire, the
   *  name as id): a packaged ladder's Auto and rungs, tallest first; the
   *  on-the-fly ladder high / medium / low (transcode only). Empty when the
   *  server sends none — a package of one rendition, remux, passthrough. */
  qualities: { id: string; label: string }[];
  default_quality?: string;
  mode?: string;
  /** The default one is what plays. */
  audio_tracks: PlayInfoTrack[];
  subtitle_tracks: PlayInfoTrack[];
}

/** A cast/crew person (GET /people search result; chino-api
 *  internal/katalog/people.go Person). */
export interface Person {
  id: string;
  name: string;
  /** Number of titles this person is credited on; omitted when 0. */
  credits?: number;
  /** The catalog holds a portrait of them. */
  has_profile?: boolean;
  /** Their portrait, "/api/v1/people/{id}/profile" (stream-token group, like
   *  a poster); set only when has_profile. Resolve it with api.assetUrl. */
  profile_url?: string;
}

/** A title on a person's filmography: a catalogue item plus the person's
 *  roles on it, in katalog-api's credit order (["director", "writer"]). */
export interface PersonCredit extends Item {
  roles?: string[];
}

/**
 * GET /people/{id}: a person, what the catalog knows about them (each field
 * omitted when unknown) and their filmography — flat on the wire, as here.
 * Dates are YYYY-MM-DD. The biography is in biography_lang: the first of the
 * request's Accept-Language languages the catalog has it in, else English,
 * else any.
 */
export interface PersonDetail extends Person {
  sort_name?: string;
  also_known_as?: string[];
  birth_date?: string;
  death_date?: string;
  birthplace?: string;
  known_for_department?: string;
  biography?: string;
  biography_lang?: string;
  tmdb_person_id?: string;
  imdb_id?: string;
  items: PersonCredit[];
}

/** A named watchlist. Every user always has exactly one default list. */
export interface Watchlist {
  id: string;
  name: string;
  is_default?: boolean;
  count?: number;
}

/** A paged list response. chino-api's /items wraps items in
 *  { product, items, source }; similar/people-style endpoints wrap in
 *  { items, total }. listItems normalises both to this shape. */
export interface ListResult {
  items: Item[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * The self-describing discovery doc at GET /api/config. The wire shape
 * carries `oidcClientId` as a per-platform map ({ tv, mobile, web }) and an
 * `apiBase` that already includes the `/api` suffix. getAppConfig flattens
 * `oidcClientId` to the TV client id (this IS the TV client).
 */
export interface AppConfig {
  oidcIssuer: string;
  oidcClientId: string;
  apiBase?: string;
}

/** Result of POST /api/v1/feedback — the created/matched ticket. */
export interface FeedbackResult {
  id: number;
  url: string;
  duplicate: boolean;
}
