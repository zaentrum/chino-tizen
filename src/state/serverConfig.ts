// Persistent store for the resolved server connection. The Add-Server flow
// (@/auth/bootstrap.bootstrapServer) produces a ServerConfig once the user
// types a URL and we've discovered the OIDC endpoints; we stash it here so the
// next cold boot skips straight to the auth gate / library instead of the
// Add-Server screen. Mirrors chino-androidtv's ServerConfigStore (the
// EncryptedSharedPreferences-backed `current()/save()/clear()` trio), but on
// Tizen the only durable surface is localStorage.
import type { ServerConfig } from '@/auth/bootstrap';

const KEY = 'chino.serverConfig';

/**
 * Read the saved ServerConfig, or null when none is stored / the blob is
 * unparseable. A corrupt entry is treated as "not configured" (and left in
 * place rather than thrown) so a malformed value can't wedge the boot gate.
 */
function get(): ServerConfig | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ServerConfig>;
    // Minimal structural guard: a config is only usable if it can actually
    // drive an API call + a device-flow sign-in. Anything missing one of the
    // four load-bearing endpoints is as good as not configured.
    if (
      typeof parsed.apiBase === 'string' &&
      typeof parsed.issuer === 'string' &&
      typeof parsed.clientId === 'string' &&
      typeof parsed.deviceAuthEndpoint === 'string' &&
      typeof parsed.tokenEndpoint === 'string'
    ) {
      return parsed as ServerConfig;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist a freshly-bootstrapped ServerConfig. */
function set(cfg: ServerConfig): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* storage disabled / quota — boot still works, just won't be remembered */
  }
}

/** Forget the configured server (Settings → Change server wipes this, then the
 *  shell falls back to the Add-Server screen on the next boot). */
function clear(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export const serverConfigStore = { get, set, clear };
