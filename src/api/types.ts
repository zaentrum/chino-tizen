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
// extra fields chino-web carries (watched_at, sort_title, and series_title +
// position/duration on continue-watching rows) so screens have the same
// data the reference client does.

/** A cast or crew credit on an item. `person_id` deep-links to /people/{id}. */
export interface CastEntry {
  // katalog-api carries the catalogue person id on each credit so the
  // detail page can link the name to the Person surface. Absent for
  // un-linked credits — the UI skips the link in that case.
  person_id?: string;
  name: string;
  role: string;
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

/** A trailer/extra reference (TMDB-sourced). */
export interface Trailer {
  site?: string;
  external_id?: string;
  url?: string;
  title?: string;
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
 * associations (genres/cast/subtitles/trailers/segments).
 */
export interface Item {
  id: string;
  type: string;
  title: string;
  sort_title?: string;
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
 *  without coordinates); it sorts first. */
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

/** Result of GET /items/{id}/play/info — the server's transcode decision
 *  plus the quality ladder it can serve. `qualities` is null on packaged
 *  items (the master playlist owns the renditions there). */
export interface PlayInfo {
  duration_ms: number;
  qualities: { id: string; label: string; height?: number }[];
  default_quality?: string;
  mode?: string;
  /** The default one is what plays. */
  audio_tracks: PlayInfoTrack[];
  subtitle_tracks: PlayInfoTrack[];
}

/** A cast/crew person summary (search result). */
export interface Person {
  id: string;
  name: string;
  // Number of titles this person is credited on.
  credits?: number;
}

/** A person plus their filmography. Wire shape is flat
 *  ({ id, name, items }); we normalise it into { person, items } so the
 *  consumer gets a tidy Person object. */
export interface PersonDetail {
  person: Person;
  items: Item[];
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
