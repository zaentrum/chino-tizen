// Engine-agnostic player contract. Two backends implement it: the Samsung
// AVPlay native pipeline (`avplay.ts`, used on-device) and the hls.js +
// HTMLVideoElement pipeline (`hls.ts`, used off-device / on TVs whose
// AVPlay can't decode the stream). The player screen drives the engine
// through this surface only — it never touches webapis.avplay or hls.js
// directly, so the AVPlay↔hls fallback is invisible above this line.
//
// Mirrors the shape chino-web's PlayerPage manipulates on <video> (play /
// pause / seek / quality / audio / text-track selection) but flattened into
// a small imperative interface so the same screen can sit on top of AVPlay,
// which is a pure JS API with no DOM media element to bind React props to.

/** Audio rendition exposed by the engine (after the stream is loaded). */
export interface PlayerAudioTrack {
  id: string;
  label: string;
  /** Its language tag as the stream gives it ("de", "ger"), if any. */
  lang?: string;
  /** The rendition playing (or picked, while the engine waits to switch). */
  selected?: boolean;
}

/** Subtitle / text rendition exposed by the engine. */
export interface PlayerTextTrack {
  id: string;
  label: string;
}

/**
 * Lifecycle + state events emitted by an engine. The screen subscribes via
 * `on()` and re-renders chrome (clock, spinner, play/pause glyph) off them.
 *   - ready       engine attached + source parsed; duration is known
 *   - playing     playback is producing frames (clears the buffer overlay)
 *   - paused      playback paused (user or engine)
 *   - timeupdate  currentTime advanced (fires ~4×/s); payload = seconds
 *   - ended       reached end of stream
 *   - error       unrecoverable engine error; payload carries a message
 *   - buffering   stalled, waiting for data (raises the buffer overlay)
 *   - firstframe  first decoded frame painted (initial spinner can clear)
 *   - tracks      the audio tracks of the source loaded are known, changed,
 *                 or another one plays: audioTracks() lists them (fires again
 *                 after every load(), so a quality switch can put the audio
 *                 picked back)
 */
export type PlayerEvent =
  | 'ready'
  | 'playing'
  | 'paused'
  | 'timeupdate'
  | 'ended'
  | 'error'
  | 'buffering'
  | 'firstframe'
  | 'tracks';

/** Optional load parameters. `startSec` seeks once the source is ready —
 *  used for auto-resume and the Zap `?resume=` channel-surf handoff. */
export interface LoadOptions {
  /** Seek here once the engine can seek (auto-resume). 0 / undefined = head. */
  startSec?: number;
}

/**
 * The unified player surface. Both engines implement every method; calls are
 * tolerant of being made before `load()` (no-op) so the screen doesn't have
 * to gate every control on a ready flag.
 */
export interface ChinoPlayer {
  /** Bind the engine to a container element (mounts the <video> / object). */
  attach(el: HTMLElement): void;
  /** Load an HLS master URL and (optionally) seek to a resume point. */
  load(url: string, o?: LoadOptions): Promise<void>;
  play(): void;
  pause(): void;
  togglePlay(): void;
  /** Seek to an absolute position, in seconds. */
  seek(sec: number): void;
  /** Current playhead, in seconds (0 before load). */
  currentTime(): number;
  /** Stream duration, in seconds (0 / NaN-safe before metadata). */
  duration(): number;
  /** Steer the engine's own level choice where it has one ('auto' / a level
   *  index on hls.js; a no-op on AVPlay). A quality pick from the menu is
   *  not this: the screen reloads the master with ?q= (@/lib/qualities). */
  setQuality(id: string): void;
  audioTracks(): PlayerAudioTrack[];
  /** Switch to an audio track of audioTracks(). An engine that cannot
   *  switch yet (AVPlay, before it plays) switches as soon as it can. */
  setAudioTrack(id: string): void;
  textTracks(): PlayerTextTrack[];
  /** Select a subtitle track, or pass null to turn subtitles off. */
  setTextTrack(id: string | null): void;
  /** Subscribe to an engine event; returns an unsubscribe function. */
  on(ev: PlayerEvent, cb: (d?: unknown) => void): () => void;
  /** Tear the engine down (detach media, destroy hls / AVPlay, free worker). */
  destroy(): void;
}

/** Which backend to construct. `createPlayer` picks one automatically when
 *  `prefer` is omitted (AVPlay on Tizen, hls elsewhere). */
export type PlayerKind = 'avplay' | 'hls';

/**
 * A subtitle track as the player offers it (see @/lib/subtitles): chino-web's
 * merged list of chino-api's sidecars and the embedded text streams. Text
 * formats (webvtt/srt) are drawn by the player screen's own overlay on every
 * engine; `pgs` needs an engine that renders it (SubtitleCapableEngine). URLs
 * are absolute and carry the `?stream=` token (chino-api
 * proxySidecarSubtitle / proxyEmbeddedSubtitle sit in the stream-token group).
 */
export interface PlayerSubtitle {
  id: string;
  /** What the menu shows: the language by name ("English (SDH)"). */
  label: string;
  /** ISO 639-1 where known ("en"), "" when the track names no language. */
  lang: string;
  url: string;
  /** 'pgs' → libpgs canvas overlay; anything else → text. */
  format?: string;
  default?: boolean;
  /** Covers only the foreign-language lines of the original audio. */
  forced?: boolean;
}

/**
 * Optional capability: an engine that draws bitmap (PGS) subtitles itself —
 * the hls.js engine, through libpgs on a canvas over its <video>. AVPlay has
 * no such renderer, so PGS tracks are not offered there. The screen
 * feature-detects with `'setSubtitles' in player`, hands it the PGS tracks and
 * selects one with setTextTrack(id) (null when a text track or none is on).
 */
export interface SubtitleCapableEngine {
  /** Replace the set of PGS tracks the engine may be asked to draw. */
  setSubtitles(subs: PlayerSubtitle[]): void;
}
