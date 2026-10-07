// What this TV decodes, as the ?caps= chino-stream reads (ParseCaps in
// chino-stream/internal/play/ffprobe.go): video avc / hvc / av1 with an
// optional ":<height>", audio aac / mp3 / opus / ac3 / eac3. A token that is
// missing means "not decoded here": a packaged ladder is served without the
// rungs and audio groups it names (no HEVC rungs without hvc, no 5.1 E-AC-3
// group without eac3), anything else is transcoded. The full player and its
// quality switch send the string built here, Zap the same without the 5.1
// companions' tokens (capsFor). Pure: caps.test.ts runs it with faked
// webapis under node --test.
//
// What a Tizen web app can ask, per Samsung's references:
//   - Which codecs: only the web engine's own queries,
//     MediaSource.isTypeSupported and a <video>'s canPlayType. AVPlay, which
//     plays our streams, has no capability query (its getCodecInfo, from
//     Tizen 10.0, names the codec of what is playing). Samsung's MSE and its
//     native player sit on the same decoders, so either query saying yes
//     counts; a codec neither says yes to is not claimed — but E-AC-3 where
//     AVPlay plays (below).
//   - How tall: webapis.productinfo.isUdPanelSupported() (4K or 8K) and
//     is8KPanelSupported(), the check Samsung's 4K/8K UHD guide gives before
//     playing UHD through AVPlay. HEVC and AV1 are asked for up to the panel,
//     H.264 up to 2160 at most (its levels end at 4K). Both need the public
//     productinfo privilege (config.xml).
//   - Not used: webapis.avinfo reports HDR (isHdrTvSupport) and a Dolby
//     Digital compression mode — neither says what the TV decodes, and caps
//     has no HDR token; tizen.systeminfo has the platform version and the
//     size of the app's screen (1920x1080 on a 4K set too), no codecs;
//     tizen.tvaudiocontrol's getOutputMode names the output the sound
//     settings pick (DOLBY_DIGITAL_PLUS only from Tizen 5.5, its privilege
//     deprecated from 5.0), not what the TV decodes.
//
// E-AC-3 is not asked where AVPlay plays: Samsung's media specifications list
// DD+ (E-AC-3) among the audio codecs of every model group, to 5.1 — the
// channels of a package's companions — in each TV year read (2017 to 2020,
// 2022, 2024, 2025), and AVPlay has no query to ask instead. The TV plays it,
// or passes it through to a sound system. So a TV playing through AVPlay is
// sent eac3, the 5.1 companions, whatever its web engine says of its own
// pipeline — in the full player; Zap's previews stay stereo (capsFor). One
// without AVPlay plays through MSE (hls.js), where the engine's answer
// counts, as off a TV.
//
// Where a query is missing the answer is conservative: no codec query at all
// → avc + aac + mp3; a TV whose panel cannot be read → 1080 for every codec.
// avc and aac are always sent — they are what chino-stream transcodes to,
// every TV this client runs on decodes them, and caps without a video codec
// would leave the server nothing to serve. `aacmc` (AAC beyond two channels)
// is never sent, as chino-web does not: a stereo downmix is the safe default.
//
// Off a TV (desktop development) the browser is asked as chino-web asks it —
// isTypeSupported where there is MediaSource, else canPlayType — with no
// heights: a desktop has no known decoder ceiling.

/** A codec a token names, and the type the TV is asked about for it. */
export interface CodecProbe {
  token: string;
  mime: string;
}

/** Video, in the order the tokens are sent. HEVC is asked about as Main 10
 *  (the packaged HEVC rungs are Main and Main 10, and a Main 10 decoder
 *  plays both), AV1 as its Main profile at 10 bits. */
export const VIDEO_PROBES: readonly CodecProbe[] = [
  { token: 'avc', mime: 'video/mp4; codecs="avc1.640028"' },
  { token: 'hvc', mime: 'video/mp4; codecs="hvc1.2.4.L120.B0"' },
  { token: 'av1', mime: 'video/mp4; codecs="av01.0.08M.10"' },
];

/** Audio, in the order the tokens are sent. */
export const AUDIO_PROBES: readonly CodecProbe[] = [
  { token: 'aac', mime: 'audio/mp4; codecs="mp4a.40.2"' },
  { token: 'mp3', mime: 'audio/mpeg' },
  { token: 'opus', mime: 'audio/mp4; codecs="opus"' },
  { token: 'ac3', mime: 'audio/mp4; codecs="ac-3"' },
  { token: 'eac3', mime: 'audio/mp4; codecs="ec-3"' },
];

/** The tallest picture H.264 is asked for: its levels end at 4K. */
const AVC_MAX_HEIGHT = 2160;

/** The height asked for on a TV whose panel could not be read. */
const UNKNOWN_PANEL_HEIGHT = 1080;

/** The part of webapis.productinfo the caps read. */
export interface ProductInfo {
  isUdPanelSupported?: () => boolean;
  is8KPanelSupported?: () => boolean;
}

/** Where the caps are built: the runtime's answers, each one optional. */
export interface CapsEnv {
  /** Running on a Samsung TV. */
  tizen: boolean;
  /** AVPlay plays what the caps get: a Samsung TV that loaded
   *  webapis.avplay, as createPlayer picks it. Else hls.js does, through
   *  MSE. */
  avplay?: boolean;
  /** window.webapis, when the TV loaded it. */
  webapis?: { productinfo?: ProductInfo | null } | null;
  /** window.MediaSource. */
  mediaSource?: { isTypeSupported?: (type: string) => boolean } | null;
  /** A <video> to ask canPlayType. */
  video?: { canPlayType?: (type: string) => string } | null;
}

/**
 * The panel's height as productinfo reports it: 4320 for an 8K panel, 2160
 * for 4K, 1080 for anything less; null when it cannot be asked (no
 * webapis, no privilege, a firmware without the call).
 */
export function panelHeight(productinfo: ProductInfo | null | undefined): number | null {
  if (!productinfo) return null;
  try {
    if (typeof productinfo.is8KPanelSupported === 'function' && productinfo.is8KPanelSupported()) {
      return 4320;
    }
  } catch {
    /* no 8K answer on this firmware; the 4K one still tells */
  }
  try {
    if (typeof productinfo.isUdPanelSupported !== 'function') return null;
    return productinfo.isUdPanelSupported() ? 2160 : 1080;
  } catch {
    return null;
  }
}

/** The Tizen version a Samsung TV's user agent names ("… Tizen 4.0) …" →
 *  4, "Tizen 2.4.0" → 2.4); null for any other user agent. */
export function tizenVersion(userAgent: string | null | undefined): number | null {
  const m = /\bTizen (\d+)(?:\.(\d+))?/i.exec(userAgent ?? '');
  return m ? Number(`${m[1]}.${m[2] ?? '0'}`) : null;
}

/**
 * Whether AVPlay must be told SET_MODE_4K=TRUE before it prepares. Samsung's
 * streaming Q&A: "To enable streaming 4K UHD video, use the
 * setStreamingProperty() method to set the SET_MODE_4K property to TRUE",
 * and, for adaptive streaming that can change the resolution, it must be
 * TRUE "when the stream switches to 4K UHD resolution". The property is
 * deprecated for retail TVs from Tizen 5.0, where the manifest's own
 * resolutions do that job. So: a UHD panel (where the caps let 2160 rungs
 * in) on a TV before Tizen 5.0 — the 2018 sets this client starts at.
 */
export function needsUhdDecoderMode(version: number | null, panel: number | null): boolean {
  return version != null && version < 5 && panel != null && panel > 1080;
}

/** How a type is asked about, or null when nothing can be asked. */
function decoderCheck(env: CapsEnv): ((mime: string) => boolean) | null {
  const mse = env.mediaSource;
  const isTypeSupported = mse && typeof mse.isTypeSupported === 'function'
    ? (mime: string) => safe(() => mse.isTypeSupported!(mime) === true)
    : null;
  const video = env.video;
  const canPlayType = video && typeof video.canPlayType === 'function'
    ? (mime: string) => safe(() => {
        const answer = video.canPlayType!(mime);
        return answer === 'probably' || answer === 'maybe';
      })
    : null;
  if (env.tizen) {
    if (!isTypeSupported && !canPlayType) return null;
    return (mime) => (isTypeSupported?.(mime) ?? false) || (canPlayType?.(mime) ?? false);
  }
  // A browser plays our HLS through MSE (hls.js) where it has it: that is
  // the answer that counts there.
  return isTypeSupported ?? canPlayType;
}

function safe(ask: () => boolean): boolean {
  try {
    return ask();
  } catch {
    return false;
  }
}

/** The ?caps= value for this runtime (see the top of this file). */
export function deviceCaps(env: CapsEnv): string {
  const decodes = decoderCheck(env);
  const maxHeight = env.tizen
    ? panelHeight(env.webapis?.productinfo) ?? UNKNOWN_PANEL_HEIGHT
    : null;
  const sized = (token: string): string => {
    if (maxHeight == null) return token;
    return `${token}:${token === 'avc' ? Math.min(maxHeight, AVC_MAX_HEIGHT) : maxHeight}`;
  };
  const always = new Set(decodes ? ['avc', 'aac'] : ['avc', 'aac', 'mp3']);
  // Samsung's media specifications, where AVPlay plays (the top of this file).
  if (env.tizen && env.avplay) always.add('eac3');
  const tokens: string[] = [];
  for (const p of VIDEO_PROBES) {
    if (always.has(p.token) || decodes?.(p.mime)) tokens.push(sized(p.token));
  }
  for (const p of AUDIO_PROBES) {
    if (always.has(p.token) || decodes?.(p.mime)) tokens.push(p.token);
  }
  return tokens.join(',');
}

/** What the caps are asked for: the full player (a title, one of its
 *  extras) or a Zap preview. */
export type CapsMode = 'player' | 'zap';

/** The tokens a package's 5.1 companions come with: the packager's
 *  SURROUND_AUDIO writes them E-AC-3 or AC-3, and chino-stream serves either
 *  group, the companion its default, to caps that name its codec. */
const SURROUND_TOKENS = new Set(['eac3', 'ac3']);

/**
 * The caps `mode` asks with, from the device's (deviceCaps): the full
 * player's as they are; a Zap preview's without eac3 and ac3, so that it is
 * served a package's stereo AAC renditions and not the 5.1 companion a
 * title's audio would start on — a preview wants the smaller rendition and a
 * fast start, not surround. Its master, /play/info and /prewarm all ask
 * with these, as chino-stream wants a session's asked alike.
 */
export function capsFor(caps: string, mode: CapsMode): string {
  if (mode === 'player') return caps;
  return caps
    .split(',')
    .filter((t) => !SURROUND_TOKENS.has(t.split(':')[0].trim().toLowerCase()))
    .join(',');
}
