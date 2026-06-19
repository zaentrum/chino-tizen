// Public player surface for the player screen. `createPlayer` picks the
// engine: the native Samsung AVPlay pipeline on a Tizen TV (hardware
// decode for the catalog's 4K HEVC packages), the hls.js + HTMLVideoElement
// pipeline everywhere else (desktop dev, or as the on-device fallback when a
// caller explicitly prefers it). `detectCaps` builds the ?caps= beacon.
//
// The screen depends only on this module + ./types. The AVPlay↔hls choice is
// invisible above this line — both engines implement the same ChinoPlayer
// interface from ./types.

import { isTizen } from '@/tv/tizen';
import { AvplayEngine } from './avplay';
import { HlsEngine } from './hls';
import type { ChinoPlayer, PlayerKind } from './types';

export type {
  ChinoPlayer,
  PlayerKind,
  PlayerEvent,
  PlayerAudioTrack,
  PlayerTextTrack,
  PlayerSubtitle,
  SubtitleCapableEngine,
  LoadOptions,
} from './types';
export { detectCaps } from './caps';
export { AvplayEngine } from './avplay';
export { HlsEngine } from './hls';

/**
 * Build a player engine and attach it to `container`.
 *
 * @param container  The element the engine renders into (native <object> for
 *                   AVPlay, a <video> + PGS <canvas> for hls.js).
 * @param prefer     Force a backend. Omitted → AVPlay on Tizen, hls.js
 *                   elsewhere. Pass 'hls' on a Tizen panel whose AVPlay can't
 *                   decode a given stream (the screen's fallback path).
 */
export function createPlayer(
  container: HTMLElement,
  prefer?: PlayerKind,
): ChinoPlayer {
  const kind: PlayerKind = prefer ?? (isTizen() ? 'avplay' : 'hls');
  // AVPlay is only real on-device. If a caller asks for it off-device (where
  // webapis.avplay is undefined) the engine's guards make it a silent no-op,
  // which would look like a dead player — so coerce to hls there.
  const useAvplay = kind === 'avplay' && isTizen() && !!window.webapis?.avplay;
  const engine: ChinoPlayer = useAvplay ? new AvplayEngine() : new HlsEngine();
  engine.attach(container);
  return engine;
}
