// The ?caps= beacon for this device: @/lib/caps builds it from what the TV
// reports (its web engine's codec queries, the panel webapis.productinfo
// describes), here fed with the real globals. One string per app session —
// /play/info, the master and every reload of it (a quality switch, Zap) ask
// with the same caps, as chino-stream wants them asked.
//
// The webapis are loaded before the app mounts (main.tsx), so the first call
// already sees productinfo.

import { isTizen } from '@/tv/tizen';
import {
  deviceCaps,
  needsUhdDecoderMode,
  panelHeight,
  tizenVersion,
  type ProductInfo,
} from '@/lib/caps';

let caps: string | null = null;

function productinfo(): ProductInfo | null {
  return (window.webapis?.productinfo as ProductInfo | undefined) ?? null;
}

/** This device's ?caps= value (see @/lib/caps). */
export function detectCaps(): string {
  if (caps == null) {
    caps = deviceCaps({
      tizen: isTizen(),
      webapis: { productinfo: productinfo() },
      mediaSource: typeof MediaSource !== 'undefined' ? MediaSource : null,
      video: typeof document !== 'undefined' ? document.createElement('video') : null,
    });
  }
  return caps;
}

/** Whether AVPlay needs SET_MODE_4K=TRUE here: a UHD panel before Tizen 5.0
 *  (see @/lib/caps needsUhdDecoderMode). */
export function needsUhdDecoder(): boolean {
  if (!isTizen()) return false;
  return needsUhdDecoderMode(tizenVersion(navigator.userAgent), panelHeight(productinfo()));
}
