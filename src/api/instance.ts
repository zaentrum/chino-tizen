import { ChinoClient } from './client';
import { authStore } from '@/auth/session';

/**
 * The shared chino-api client, wired to the configured server + the current
 * session token. Both are read lazily per request:
 *   - baseUrl is a thunk so the instance tracks the server the user
 *     configured (authStore.getApiBase() — the `/api`-suffixed origin from
 *     GET /api/config) without rebuilding the client when it changes.
 *   - getToken is read fresh on every request so a silent token renew is
 *     picked up transparently.
 *
 * Screens import this directly: `import { api } from '@/api/instance'`.
 */
export const api = new ChinoClient({
  baseUrl: () => authStore.getApiBase() ?? '',
  getToken: () => authStore.getToken(),
});
