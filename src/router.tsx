// Tiny pathname-based history router. Same shape as chino-web's hand-rolled
// router (App.tsx pickRoute) but tuned for the Tizen shell: it exposes ONLY
// the navigation primitives — navigate / back / useRoute / matchRoute — and
// renders NOTHING. The integrator wires the screen switch in App.tsx off the
// matchRoute() result; keeping the screen table out of here means a new screen
// is one App.tsx line, not a router edit.
//
// Routes (the canonical Tizen set; named, not chino-web's `/i/:id` literals):
//   /                home
//   /browse/:type    Movies / Series overview (type = movie | series)
//   /detail/:id      movie / show detail
//   /search          search results (?q= carried separately if needed)
//   /person/:id      person / filmography
//   /watchlist       lists-aware watchlist surface
//   /settings        settings rows
//   /settings/delete-account  Delete Account (asks, then deletes)
//   /notices         what addons told the signed-in person
//   /zap             full-screen channel-surf
//   /player/:id      full-screen player
//   /trailer/:itemId/:extraId  a title's trailer, in the player's extra mode
import { useEffect, useState } from 'react';

/** A matched route: a stable `name` (used by the App.tsx screen switch) plus
 *  the extracted path params. Names are the bare segment, so `/browse/movie`
 *  resolves to `{ name: 'browse', params: { type: 'movie' } }`. */
export interface RouteMatch {
  name:
    | 'home'
    | 'browse'
    | 'detail'
    | 'search'
    | 'person'
    | 'watchlist'
    | 'settings'
    | 'deleteAccount'
    | 'notices'
    | 'zap'
    | 'player'
    | 'trailer';
  params: Record<string, string>;
}

// Ordered most-specific-first so a literal like `/watchlist` is never shadowed
// by a `:param` pattern. Each entry is a compiled matcher.
const ROUTES: { name: RouteMatch['name']; re: RegExp; keys: string[] }[] = [
  { name: 'home', re: /^\/?$/, keys: [] },
  { name: 'browse', re: /^\/browse\/([^/]+)\/?$/, keys: ['type'] },
  { name: 'detail', re: /^\/detail\/([^/]+)\/?$/, keys: ['id'] },
  { name: 'person', re: /^\/person\/([^/]+)\/?$/, keys: ['id'] },
  { name: 'player', re: /^\/player\/([^/]+)\/?$/, keys: ['id'] },
  { name: 'trailer', re: /^\/trailer\/([^/]+)\/([^/]+)\/?$/, keys: ['itemId', 'extraId'] },
  { name: 'search', re: /^\/search\/?$/, keys: [] },
  { name: 'watchlist', re: /^\/watchlist\/?$/, keys: [] },
  { name: 'settings', re: /^\/settings\/?$/, keys: [] },
  { name: 'deleteAccount', re: /^\/settings\/delete-account\/?$/, keys: [] },
  { name: 'notices', re: /^\/notices\/?$/, keys: [] },
  { name: 'zap', re: /^\/zap\/?$/, keys: [] },
];

/**
 * Resolve a pathname to a route `name` + decoded params. Unknown paths fall
 * back to `home` so a bad deep-link or an unexpected popstate still lands on a
 * renderable screen rather than a blank shell.
 */
export function matchRoute(path: string): RouteMatch {
  // Strip any query/hash — the router keys off the pathname only; screens that
  // care about `?q=` read window.location.search themselves (search).
  const clean = path.split('?')[0].split('#')[0];
  for (const r of ROUTES) {
    const m = clean.match(r.re);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1] ?? '');
    });
    return { name: r.name, params };
  }
  return { name: 'home', params: {} };
}

/**
 * Push a new path onto the history stack and notify subscribers. Use this for
 * every in-app navigation — it never reloads the page (a hard reload on a
 * .wgt-packaged Tizen app would re-run the whole boot + auth gate). A no-op
 * when the target equals the current location so re-pressing a rail item that
 * routes to the page you're already on can't stack duplicate entries.
 */
export function navigate(path: string): void {
  const full = path.startsWith('/') ? path : `/${path}`;
  if (full === window.location.pathname + window.location.search) return;
  window.history.pushState({}, '', full);
  // pushState does not emit popstate; fire our own event so useRoute() updates.
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Like [navigate], but in place of the current history entry: BACK cannot
 *  return to the screen left (Delete Account, once the account is gone). */
export function replace(path: string): void {
  const full = path.startsWith('/') ? path : `/${path}`;
  window.history.replaceState({}, '', full);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Go back one history entry. Screens wire this to TVKey.BACK. */
export function back(): void {
  window.history.back();
}

/**
 * Subscribe to the current route. Re-renders on browser Back/Forward
 * (popstate) and on every navigate() (which synthesises a popstate). Returns
 * the raw `path` + decoded `params` for the matched route.
 */
export function useRoute(): { path: string; params: Record<string, string> } {
  const [path, setPath] = useState(
    () => window.location.pathname + window.location.search,
  );
  useEffect(() => {
    const onPop = () =>
      setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return { path, params: matchRoute(path).params };
}
