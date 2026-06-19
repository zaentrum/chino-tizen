// Minimal ambient typings for the Samsung Tizen TV Web Device APIs we touch.
// These globals only exist on-device; off-device (desktop dev) they are
// undefined, so every call site must guard. Kept loose (any) on purpose —
// the full AVPlay surface is large and we only narrow what we use.
export {};

declare global {
  interface Window {
    tizen?: {
      tvinputdevice?: {
        registerKey(name: string): void;
        registerKeys?(names: string[]): void;
      };
      application?: {
        getCurrentApplication(): { exit(): void };
      };
      systeminfo?: unknown;
    };
    webapis?: {
      avplay?: unknown;
      productinfo?: unknown;
    };
  }
}
