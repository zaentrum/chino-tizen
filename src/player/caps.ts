// Codec-capability beacon for the ?caps= query parameter chino-stream's
// ParseCaps consumes (chino-stream/internal/play/ffprobe.go::ParseCaps).
// Comma-separated tokens; a missing token means "this client can't decode
// that codec, transcode it for me".
//
// Vocabulary (matches chino-web PlayerPage's initialCaps + androidtv
// CodecCaps.kt): video → avc / hvc / av1 (+ optional ":maxHeight" suffix);
// audio → aac / mp3 / opus / ac3 / eac3.
//
// Strategy, in priority order:
//   1. On Tizen we trust the panel: Samsung Smart TVs (2018+, Tizen 4.0+)
//      ship hardware HEVC Main10 up to 4K and H.264 High@5.1; many 2020+
//      sets add AV1. We answer from the productinfo/avplay surface where it
//      can, else from a conservative TV-class default. canPlayType on the
//      Tizen WebKit is unreliable for HEVC (returns "" even though AVPlay
//      decodes it), so we do NOT gate the TV path on it.
//   2. Off-device (desktop dev / non-Tizen browser) we probe exactly like
//      chino-web: MediaSource.isTypeSupported first, canPlayType as a
//      fallback for the native-HLS path (Safari, which has no MSE).
//
// Two intentional omissions carried over from chino-web + androidtv:
//   * `aacmc` (multi-channel AAC) is never advertised — MSE-style pipelines
//     reject 5.1/7.1 fmp4 segments; always-downmix-to-stereo on the server
//     is the safe default. AVPlay tolerates multichannel, but advertising
//     aacmc only helps the hls.js path, where it hurts, so we drop it
//     everywhere for one consistent caps string per device.
//   * A bare video token (no ":height") means "supported, no known hardware
//     height ceiling" and parses exactly as the legacy form did.

import { isTizen } from '@/tv/tizen';

// MIME probes for the off-device path. Mirror chino-web's initialCaps exactly
// so a desktop dev session negotiates the same pipeline the web client does.
const VIDEO_PROBES: { token: string; mime: string }[] = [
  { token: 'avc', mime: 'video/mp4; codecs="avc1.640028"' },
  { token: 'hvc', mime: 'video/mp4; codecs="hvc1.1.6.L120.B0"' },
  { token: 'av1', mime: 'video/mp4; codecs="av01.0.05M.08"' },
];
const AUDIO_PROBES: { token: string; mime: string }[] = [
  { token: 'aac', mime: 'audio/mp4; codecs="mp4a.40.2"' },
  { token: 'mp3', mime: 'audio/mpeg' },
  { token: 'opus', mime: 'audio/mp4; codecs="opus"' },
  { token: 'ac3', mime: 'audio/mp4; codecs="ac-3"' },
  { token: 'eac3', mime: 'audio/mp4; codecs="ec-3"' },
];

// One detached <video> reused for canPlayType probes; cheap to keep around
// and avoids re-creating an element on every call.
let probeVideo: HTMLVideoElement | null = null;
function probeEl(): HTMLVideoElement | null {
  if (typeof document === 'undefined') return null;
  if (!probeVideo) probeVideo = document.createElement('video');
  return probeVideo;
}

// Same two-signal check chino-web uses: MSE first, then canPlayType. On the
// native-HLS path (no MediaSource) canPlayType is authoritative — both
// "maybe" and "probably" count as playable.
function isCodecSupported(mime: string): boolean {
  if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported) {
    if (MediaSource.isTypeSupported(mime)) return true;
  }
  const v = probeEl();
  if (v) {
    const cpt = v.canPlayType(mime);
    if (cpt === 'probably' || cpt === 'maybe') return true;
  }
  return false;
}

// Conservative TV-class default. Every Tizen 4.0+ panel decodes H.264 and
// HEVC Main10 in hardware (the floor for AVPlay'ing the catalog's 4K HEVC
// packages); the height suffix routes oversized packages correctly server
// side (chino-stream codecFamily()). AV1 is added below only when AVPlay
// confirms it, since pre-2020 sets lack a hardware AV1 decoder and would
// drop to a software path that crawls on 4K — the same SM-T500 trap
// CodecCaps.kt's height ceiling guards against.
const TV_DEFAULT_TOKENS = ['avc:2160', 'hvc:2160', 'aac', 'mp3', 'ac3', 'eac3'];

// Whether AVPlay advertises a decoder for the given streaming MIME. AVPlay's
// canPlayType-style probe lives on the static AVPlayManager surface as
// `webapis.avplay.getAVPlay()…` on some firmwares, but the universally-present
// check is the standalone `webapis.avplay` `isAvailable`-style call. We guard
// everything and fall back to "unknown" (undefined) when the API isn't there.
function tizenSupports(mime: string): boolean | undefined {
  try {
    const avplay = window.webapis?.avplay as
      | { getAVPlay?: () => unknown }
      | undefined;
    // Some firmwares expose AVPlayManager.isAvailable(mime); most do not.
    // Cast loosely — the ambient typings keep avplay as `unknown` on purpose.
    const mgr = (window.webapis as unknown as {
      avplay?: { isAvailable?: (m: string) => boolean };
    })?.avplay;
    if (mgr && typeof mgr.isAvailable === 'function') {
      return mgr.isAvailable(mime);
    }
    void avplay;
  } catch {
    /* AVPlay probe not supported on this model — treat as unknown. */
  }
  return undefined;
}

/**
 * Build the `?caps=` token list for THIS device. Synchronous + memo-friendly
 * (the screen computes it once at mount, exactly like chino-web's
 * `useMemo(detectCaps, [])`).
 */
export function detectCaps(): string {
  // ---- On-device (Tizen) ----
  if (isTizen()) {
    const out = [...TV_DEFAULT_TOKENS];
    // AV1: only advertise when AVPlay positively confirms a decoder. If the
    // probe is unavailable (undefined) we stay conservative and omit it —
    // letting the server transcode AV1 to H.264 is far better than a
    // software-decode crawl on a panel that doesn't actually have it.
    const av1 = tizenSupports('video/av01');
    if (av1 === true) out.push('av1:2160');
    // Opus rarely appears in our catalog and older panels reject it in the
    // AVPlay demuxer; include only on explicit confirmation.
    const opus = tizenSupports('audio/opus');
    if (opus === true) out.push('opus');
    return out.join(',');
  }

  // ---- Off-device (desktop browser / non-Tizen) ----
  // Probe exactly like chino-web so a dev session negotiates the same
  // pipeline the production web client would.
  const t: string[] = [];
  for (const p of VIDEO_PROBES) if (isCodecSupported(p.mime)) t.push(p.token);
  for (const p of AUDIO_PROBES) if (isCodecSupported(p.mime)) t.push(p.token);
  // Defensive fallback: if probing turned up nothing usable (e.g. a headless
  // dev runtime with no MediaSource and no <video>), advertise the same
  // conservative floor the contract suggests so the server still has enough
  // to pick a pipeline instead of falling back to its no-hvc DefaultCaps.
  if (!t.some((x) => x === 'avc' || x === 'hvc')) {
    return 'avc:1080,hvc:1080,aac';
  }
  return t.join(',');
}
