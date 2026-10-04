// What this TV decodes, as the ?caps= chino-stream reads (ParseCaps in
// chino-stream/internal/play/ffprobe.go): video avc / hvc / av1 with an
// optional ":<height>", audio aac / mp3 / opus / ac3 / eac3. A token that is
// missing means "not decoded here": a packaged ladder is served without the
// rungs and audio groups it names (no HEVC rungs without hvc, no 5.1 E-AC-3
// group without eac3), anything else is transcoded. The player, the quality
// switch and Zap send the one string built here. Pure: caps.test.ts runs it
// with faked webapis under node --test.
//
// What a Tizen web app can ask, per Samsung's references:
//   - Which codecs: only the web engine's own queries,
//     MediaSource.isTypeSupported and a <video>'s canPlayType. AVPlay, which
//     plays our streams, has no capability query (its getCodecInfo, from
//     Tizen 10.0, names the codec of what is playing). Samsung's MSE and its
//     native player sit on the same decoders, so either query saying yes
//     counts; a codec neither says yes to is not claimed.
//   - How tall: webapis.productinfo.isUdPanelSupported() (4K or 8K) and
//     is8KPanelSupported(), the check Samsung's 4K/8K UHD guide gives before
//     playing UHD through AVPlay. HEVC and AV1 are asked for up to the panel,
//     H.264 up to 2160 at most (its levels end at 4K). Both need the public
//     productinfo privilege (config.xml).
//   - Not used: webapis.avinfo reports HDR (isHdrTvSupport) and a Dolby
//     Digital compression mode — neither says what the TV decodes, and caps
//     has no HDR token; tizen.systeminfo has the platform version and the
//     size of the app's screen (1920x1080 on a 4K set too), no codecs.
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
  /** Running on a Samsung TV, where AVPlay plays what the caps get. */
  tizen: boolean;
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
  const tokens: string[] = [];
  for (const p of VIDEO_PROBES) {
    if (always.has(p.token) || decodes?.(p.mime)) tokens.push(sized(p.token));
  }
  for (const p of AUDIO_PROBES) {
    if (always.has(p.token) || decodes?.(p.mime)) tokens.push(p.token);
  }
  return tokens.join(',');
}
