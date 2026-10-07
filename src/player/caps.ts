// The ?caps= beacon for this device: @/lib/caps builds it from what the TV
// reports (its web engine's codec queries, the panel webapis.productinfo
// describes) and, for E-AC-3, from whether AVPlay plays, here fed with the
// real globals — once per app session, then asked for per mode (capsFor):
// the full player's with the 5.1 companions where the TV decodes them, Zap's
// without. One string per mode: the full player's /play/info, its master and
// every reload of it (a quality switch) ask with the same caps, as
// chino-stream wants them asked, and so does each Zap clip.
//
// The webapis are loaded before the app mounts (main.tsx), so the first call
// already sees productinfo and avplay, as createPlayer does.

import { isTizen } from '@/tv/tizen';
import {
  capsFor,
  deviceCaps,
  needsUhdDecoderMode,
  panelHeight,
  tizenVersion,
  type CapsMode,
  type ProductInfo,
} from '@/lib/caps';

let caps: string | null = null;

function productinfo(): ProductInfo | null {
  return (window.webapis?.productinfo as ProductInfo | undefined) ?? null;
}

/** This device's ?caps= value for `mode` (see @/lib/caps capsFor): 'player'
 *  for the full player; without a mode, as ZapScreen asks, a Zap preview's —
 *  stereo AAC, never the 5.1 companions. */
export function detectCaps(mode: CapsMode = 'zap'): string {
  if (caps == null) {
    caps = deviceCaps({
      tizen: isTizen(),
      // createPlayer's choice: AVPlay on a TV that has it.
      avplay: isTizen() && !!window.webapis?.avplay,
      webapis: { productinfo: productinfo() },
      mediaSource: typeof MediaSource !== 'undefined' ? MediaSource : null,
      video: typeof document !== 'undefined' ? document.createElement('video') : null,
    });
  }
  return capsFor(caps, mode);
}

/** Whether AVPlay needs SET_MODE_4K=TRUE here: a UHD panel before Tizen 5.0
 *  (see @/lib/caps needsUhdDecoderMode). */
export function needsUhdDecoder(): boolean {
  if (!isTizen()) return false;
  return needsUhdDecoderMode(tizenVersion(navigator.userAgent), panelHeight(productinfo()));
}
