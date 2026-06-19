// Samsung TV remote key codes (as delivered to a `keydown` handler) plus the
// registration call for the keys the platform does NOT deliver by default
// (media transport, colour, channel). Arrow keys + Enter + Back arrive without
// registration. Mirrors the chino-androidtv DPAD map so UX stays in parity.

export const TVKey = {
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
  ENTER: 13,
  BACK: 10009,
  MENU: 10133,
  MEDIA_PLAY_PAUSE: 10252,
  MEDIA_PLAY: 415,
  MEDIA_PAUSE: 19,
  MEDIA_STOP: 413,
  MEDIA_REWIND: 412,
  MEDIA_FAST_FORWARD: 417,
  CHANNEL_UP: 427,
  CHANNEL_DOWN: 428,
  COLOR_RED: 403,
  COLOR_GREEN: 404,
  COLOR_YELLOW: 405,
  COLOR_BLUE: 406,
} as const;

// Register the extra remote keys so they reach our keydown handler. Names are
// the Tizen TV input-device key names. Safe no-op off-device.
export function registerRemoteKeys(): void {
  const dev = window.tizen?.tvinputdevice;
  if (!dev) return;
  const want = [
    'MediaPlayPause',
    'MediaPlay',
    'MediaPause',
    'MediaStop',
    'MediaRewind',
    'MediaFastForward',
    'ChannelUp',
    'ChannelDown',
    'ColorF0Red',
    'ColorF1Green',
    'ColorF2Yellow',
    'ColorF3Blue',
  ];
  for (const name of want) {
    try {
      dev.registerKey(name);
    } catch {
      /* key not supported on this model — ignore */
    }
  }
}
