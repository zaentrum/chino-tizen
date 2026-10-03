// URLs of the media assets chino-api hands out — posters, backdrops, a
// person's portrait, sidecar subtitles — made loadable by an <img> or a fetch.
//
// chino-api writes them origin-relative ("/api/v1/items/{id}/poster"), because
// chino-web is served from the same origin. This client talks to a configured
// server whose API base already ends at "/api" ("https://host/api", or
// "https://host/media/api" behind a path prefix), so an "/api/..." path is
// re-rooted on that base rather than appended to it: appending produced
// "https://host/api/api/v1/...", a 404 for every poster.
//
// The routes sit in chino-api's stream-token group: an <img> cannot send the
// bearer header, so the URL carries the long-lived stream token as ?stream=.
// Pure: artwork.test.ts runs it under node --test.

/** `path` as chino-api handed it out, absolute against `apiBase` (the API root
 *  ending at "/api"). Absolute URLs pass through; nothing in, nothing out. */
export function apiUrl(apiBase: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  const base = (apiBase || '').replace(/\/+$/, '');
  if (!base) return path;
  if (path === '/api' || path.startsWith('/api/') || path.startsWith('/api?')) {
    return base + path.slice(4);
  }
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** `url` with the stream token as ?stream= (or &stream=); the URL unchanged
 *  while there is no token yet, nothing when there is no URL. */
export function withStreamToken(
  url: string | undefined,
  token: string | null | undefined,
): string | undefined {
  if (!url) return undefined;
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}stream=${encodeURIComponent(token)}`;
}
