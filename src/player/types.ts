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
 */
export type PlayerEvent =
  | 'ready'
  | 'playing'
  | 'paused'
  | 'timeupdate'
  | 'ended'
  | 'error'
  | 'buffering'
  | 'firstframe';

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
  /** Switch the video quality rung ('high' | 'medium' | 'low' for our
   *  server's single-variant ladder, or an ABR auto level on hls.js). */
  setQuality(id: string): void;
  audioTracks(): PlayerAudioTrack[];
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
 * Subtitle descriptor the screen hands to an engine via `setTextTracks`.
 * Mirrors chino-web's merged subtitle entry: text formats (webvtt/srt) ride
 * the native <track>/AVPlay sidecar path, `pgs` rides the libpgs canvas
 * overlay. URLs already carry the `?stream=` token (see chino-api
 * proxySidecarSubtitle / proxyEmbeddedSubtitle).
 */
export interface PlayerSubtitle {
  id: string;
  label: string;
  lang: string;
  url: string;
  /** 'pgs' → libpgs canvas overlay; anything else → native text track. */
  format?: string;
  default?: boolean;
}

/**
 * Optional capability an engine MAY expose for sidecar subtitles. Declared
 * here (not on ChinoPlayer) because the hls engine renders subtitles itself
 * via <track> + libpgs, while AVPlay's subtitle plumbing differs; the screen
 * feature-detects with `'setSubtitles' in player`.
 */
export interface SubtitleCapableEngine {
  /** Replace the set of selectable sidecar / embedded subtitle tracks. */
  setSubtitles(subs: PlayerSubtitle[]): void;
}
