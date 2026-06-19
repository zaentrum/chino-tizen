// Runtime detection + lazy loader for the Samsung TV Web Device API
// (webapis.js, which exposes AVPlay, productinfo, etc.). On a desktop browser
// this is a no-op so the app still boots for development.

export const isTizen = (): boolean => /Tizen/i.test(navigator.userAgent);

let loaded: Promise<void> | null = null;

export function loadWebapis(): Promise<void> {
  if (loaded) return loaded;
  if (!isTizen() || window.webapis) {
    loaded = Promise.resolve();
    return loaded;
  }
  loaded = new Promise<void>((resolve) => {
    const s = document.createElement('script');
    // $WEBAPIS is resolved by the Tizen web runtime at load time on-device.
    s.src = '$WEBAPIS/webapis/webapis.js';
    s.onload = () => resolve();
    s.onerror = () => resolve(); // degrade gracefully → hls.js fallback path
    document.head.appendChild(s);
  });
  return loaded;
}
