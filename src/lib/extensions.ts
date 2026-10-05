// What an addon's slot row may make the TV do. Addons contribute rows to named
// slots in the portal's registry; the app reads a slot's rows through
// chino-api (GET /api/v1/extensions?slot=) and draws them as its own buttons.
// The rows are data from elsewhere, so a row shows only when what it points
// at is safe behind a native button — chino-web's rules (its
// src/lib/extensions.ts), ported: an enabled row with a label, either a
// `link` to an http(s) page of the server's own origin, or an `action`, a
// POST carrying the viewer's bearer, to the portal's app proxy on that
// origin. A row of another kind, or pointing anywhere else, shows nothing.
//
// chino-web resolves a row against the page it is on. This app runs from a
// packaged origin of its own, so a row is resolved against the configured
// server's origin, and only in the two forms portal-api serves: a path on the
// server, or an absolute URL on its origin. A TV has no browser to open a
// link in: the slot shows a link's address, for a phone or computer
// (components/ExtensionSlot). Pure: extensions.test.ts runs it under
// node --test, the action against a fake fetch.

/** A slot row as chino-api serves it (portal-api's model.Extension). Typed
 *  loosely on purpose: every field is checked before it is used. */
export interface SlotRow {
  key?: unknown;
  kind?: unknown;
  label?: unknown;
  icon?: unknown;
  url?: unknown;
  method?: unknown;
  enabled?: unknown;
}

export type SlotKind = 'link' | 'action';

/** The icons a row may name, from the portal's palette (zaentrum-portal
 *  src/lib/icons.tsx) as far as this app draws it, so a row shows the same
 *  glyph on the launchpad and here. A fixed list, not a lookup into lucide's
 *  exports: those include components that are not icons at all, and reaching
 *  any of them by name puts every icon in the bundle. */
export const SLOT_ICON_NAMES = [
  'library',
  'radar',
  'tv',
  'music',
  'clapperboard',
  'settings',
  'layout-grid',
  'server',
  'boxes',
  'globe',
  'wrench',
  'file-text',
  'image',
  'list-video',
  'users',
  'gauge',
  'database',
  'puzzle',
] as const;

export type SlotIconName = (typeof SLOT_ICON_NAMES)[number];

/** A row that passed: what the slot shows, with the address resolved. */
export interface SlotButton {
  key: string;
  kind: SlotKind;
  label: string;
  icon: SlotIconName;
  /** A link's address, or the URL an action POSTs to. */
  href: string;
}

/** The portal's app proxy: /api/portal/apps/<key>/… reaches an addon's own
 *  backend, forwarding the viewer's bearer for the addon to authorise. */
export const PORTAL_APP_PROXY = '/api/portal/apps/';

/** The server's origin — what every row must stay on — from the configured
 *  API base ("https://media.example.org/api"); null without an http(s) one. */
export function serverOrigin(apiBase: string | null | undefined): string | null {
  if (!apiBase) return null;
  try {
    const u = new URL(apiBase);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** {var} tokens in a slot URL, replaced by the encoded value (unknown: ''). */
export function substitute(url: string, vars: Record<string, string>): string {
  return url.replace(/\{(\w+)\}/g, (_, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? encodeURIComponent(vars[k]) : '',
  );
}

/** A row's icon as a palette name: kebab or lower case as the portal stores
 *  it ("list-video"), or as lucide spells the export ("ListVideo"). Any
 *  other name is the puzzle, the portal's icon for an installed addon. */
export function slotIconName(raw: unknown): SlotIconName {
  if (typeof raw !== 'string') return 'puzzle';
  const name = raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
  return (SLOT_ICON_NAMES as readonly string[]).includes(name) ? (name as SlotIconName) : 'puzzle';
}

/** The two kinds the slot shows; anything else (an unknown or empty kind) is
 *  not something it knows how to show, so it shows nothing. */
export function slotKind(raw: unknown): SlotKind | null {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toLowerCase();
  return k === 'link' || k === 'action' ? k : null;
}

/**
 * The address a slot `link` row leads to on the server whose origin is
 * `origin`, or null when it may lead nowhere: only an http(s) page of that
 * origin, written as a path ("/portal/app/x?q={q}") or absolute. Anything
 * else — a javascript: or data: URL, another host, a protocol-relative
 * "//host", a URL with credentials, a URL relative to a page — shows no
 * button at all.
 */
export function slotLinkHref(raw: unknown, origin: string, vars: Record<string, string> = {}): string | null {
  const u = resolve(raw, origin, vars);
  return u ? u.href : null;
}

/**
 * The URL a slot `action` row may POST to, or null. An action sends the
 * viewer's bearer, so it goes only to the portal's app proxy on the server's
 * own origin (/api/portal/apps/<key>/…) and only as a POST (no method means
 * POST): the token never leaves the origin, and a row cannot spend it on
 * chino-api's or the portal's own endpoints.
 */
export function slotActionUrl(
  raw: unknown,
  method: unknown,
  origin: string,
  vars: Record<string, string> = {},
): string | null {
  if (method !== undefined && method !== null && method !== '') {
    if (typeof method !== 'string' || method.trim().toUpperCase() !== 'POST') return null;
  }
  const u = resolve(raw, origin, vars);
  if (!u) return null;
  // An encoded separator may become a real one behind a proxy.
  if (/%2f|%5c/i.test(u.pathname)) return null;
  // The path is already normalised: "..", "%2e%2e" are resolved away.
  if (!new RegExp(`^${PORTAL_APP_PROXY}[^/]+(/|$)`).test(u.pathname)) return null;
  return u.href;
}

/** The rows of a slot the app can show, in the order given. */
export function slotButtons(rows: unknown, origin: string | null, vars: Record<string, string> = {}): SlotButton[] {
  if (!Array.isArray(rows) || !origin) return [];
  const out: SlotButton[] = [];
  rows.forEach((row: SlotRow, i) => {
    if (!row || typeof row !== 'object' || !row.enabled) return;
    const label = typeof row.label === 'string' ? row.label.trim() : '';
    if (!label) return;
    const kind = slotKind(row.kind);
    if (!kind) return;
    const href =
      kind === 'link' ? slotLinkHref(row.url, origin, vars) : slotActionUrl(row.url, row.method, origin, vars);
    if (!href) return;
    out.push({
      key: typeof row.key === 'string' && row.key ? row.key : `row-${i}`,
      kind,
      label,
      icon: slotIconName(row.icon),
      href,
    });
  });
  return out;
}

/** How an action went: the addon took it (any 2xx), or it did not get there. */
export type SlotActionResult = 'sent' | 'failed';

/**
 * POSTs a slot action — no body, as chino-web sends one — with the viewer's
 * bearer in the Authorization header. `href` is a SlotButton's, already held
 * to the action rule. A redirect is refused rather than followed: it could
 * carry the bearer somewhere the URL check never saw. Never throws.
 */
export async function sendSlotAction(opts: {
  href: string;
  /** The viewer's access token; nothing is sent without one. */
  token: string | null;
  /** For tests; the browser's fetch otherwise. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<SlotActionResult> {
  if (!opts.token) return 'failed';
  const doFetch = opts.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  try {
    const res = await doFetch(opts.href, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${opts.token}` },
    });
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

/** The URL a row names, resolved on the server's origin; null unless it is a
 *  path there or an absolute http(s) URL of that origin, without
 *  credentials. A protocol-relative "//host" — which a backslash spells too —
 *  names another host, and the app has no page a relative URL could mean. */
function resolve(raw: unknown, origin: string, vars: Record<string, string>): URL | null {
  if (typeof raw !== 'string') return null;
  const written = raw.trim();
  if (!/^(\/(?![/\\])|https?:\/\/)/i.test(written)) return null;
  let base: URL;
  let u: URL;
  try {
    base = new URL(origin);
    u = new URL(substitute(written, vars), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.origin !== base.origin) return null;
  if (u.username || u.password) return null;
  return u;
}
