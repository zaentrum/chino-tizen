// Turns a user-entered server address into a ready [ServerConfig] by probing
// the server: confirm it is reachable and is a Chino server (/api/healthz),
// read its self-describing config (/api/config) for the OIDC issuer + the
// per-platform public client id, then run OIDC discovery against that issuer
// for the device-authorization + token endpoints. Distinct failure kinds let
// the Add-Server UI show actionable errors. Mirrors chino-androidtv
// data/ServerBootstrap.kt + data/auth/OidcDiscovery.kt.

import { BootstrapError, type BootstrapErrorKind, type ServerConfig } from './types';

// Re-export ServerConfig from this module: @/state.serverConfigStore imports
// the type from '@/auth/bootstrap' (the producer of a ServerConfig), so the
// type's canonical import site is here even though it's declared in ./types.
export type { ServerConfig } from './types';

// Short per-request timeout: probe() tries up to TWO candidates (https then
// http) for a bare host, so 6s keeps an unreachable address under ~12s total.
const PROBE_TIMEOUT_MS = 6000;
const DISCOVERY_TIMEOUT_MS = 8000;

/**
 * Trims, defaults the scheme to https, strips a trailing slash. Used for the
 * recents key and same-server comparison; [candidates] derives its own
 * candidate set (which may also try http). Mirrors ServerBootstrap.normalize.
 */
export function normalize(raw: string): string {
  let s = raw.trim();
  if (s === '') return s;
  if (!s.startsWith('http://') && !s.startsWith('https://')) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}

/**
 * Candidate base origins to probe, in priority order, each trailing-slash
 * trimmed. With no scheme we infer one and try https THEN http (most
 * self-host servers are https, but a LAN box may only speak plain http). With
 * an explicit scheme we honour it first, then try the other as a fallback.
 * Mirrors ServerBootstrap.candidates.
 */
export function candidates(raw: string): string[] {
  const s = raw.trim();
  if (s === '') return [];
  let list: string[];
  if (s.startsWith('https://')) {
    const host = s.slice('https://'.length);
    list = [`https://${host}`, `http://${host}`];
  } else if (s.startsWith('http://')) {
    const host = s.slice('http://'.length);
    list = [`http://${host}`, `https://${host}`];
  } else {
    list = [`https://${s}`, `http://${s}`];
  }
  return Array.from(new Set(list.map((u) => u.replace(/\/+$/, ''))));
}

/** Best-effort fetch+JSON with a timeout. Returns null on any network/parse
 *  error (a browser fetch can't distinguish a TLS failure from an unreachable
 *  host — both surface as a generic TypeError). */
async function getJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'GET', signal: ctrl.signal });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface HealthDoc {
  status?: string;
  product?: string;
}

interface AppConfigDoc {
  product?: string;
  apiBase?: string;
  oidcIssuer?: string;
  oidcAudience?: string;
  oidcEnabled?: boolean;
  // chino-api returns oidcClientId as a per-platform map; older/other servers
  // may return a bare string — accept both.
  oidcClientId?: string | { tv?: string; mobile?: string; web?: string };
}

interface ProviderMetadata {
  issuer?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  device_authorization_endpoint?: string;
  jwks_uri?: string;
}

/** Internal probe outcome: a resolved config or a typed failure. */
type ProbeOutcome =
  | { ok: true; config: ServerConfig }
  | { ok: false; kind: BootstrapErrorKind; detail?: string };

/**
 * OIDC Authorization-Server metadata discovery (RFC 8414 + OIDC Discovery
 * 1.0). For an issuer WITH a path component (Keycloak issuers look like
 * https://host/realms/name) RFC 8414 inserts the well-known segment before the
 * path while OIDC Discovery 1.0 appends it; Keycloak answers the appended
 * form, so we try the RFC 8414 form first and fall back to the appended one.
 * device_authorization_endpoint is required for the TV's RFC 8628 sign-in.
 * Mirrors OidcDiscovery.kt.
 */
function discoveryUrls(issuer: string): string[] {
  const trimmed = issuer.replace(/\/+$/, '');
  const schemeEnd = trimmed.indexOf('://');
  if (schemeEnd < 0) return [`${trimmed}/.well-known/openid-configuration`];
  const afterScheme = schemeEnd + 3;
  const slash = trimmed.indexOf('/', afterScheme);
  if (slash < 0) return [`${trimmed}/.well-known/openid-configuration`];
  const origin = trimmed.slice(0, slash);
  const path = trimmed.slice(slash);
  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${trimmed}/.well-known/openid-configuration`,
  ];
}

interface DiscoveredEndpoints {
  issuer: string;
  deviceAuthEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
}

async function discover(issuer: string): Promise<DiscoveredEndpoints | null> {
  const trimmed = issuer.replace(/\/+$/, '');
  for (const url of discoveryUrls(trimmed)) {
    const doc = await getJson<ProviderMetadata>(url, DISCOVERY_TIMEOUT_MS);
    if (!doc) continue;
    const device = doc.device_authorization_endpoint;
    const token = doc.token_endpoint;
    if (!device || !token) continue;
    return {
      issuer: doc.issuer ?? trimmed,
      deviceAuthEndpoint: device,
      tokenEndpoint: token,
      userinfoEndpoint:
        doc.userinfo_endpoint ?? `${trimmed}/protocol/openid-connect/userinfo`,
    };
  }
  return null;
}

/** Picks the per-platform client id, falling back to the unified `chino`
 *  client. Mirrors `cfg.oidcClientId?.tv ?: "chino"`. */
function clientIdFor(cfg: AppConfigDoc): string {
  const c = cfg.oidcClientId;
  if (typeof c === 'string' && c.trim() !== '') return c;
  if (c && typeof c === 'object' && c.tv && c.tv.trim() !== '') return c.tv;
  return 'chino';
}

/** Runs the healthz -> /api/config -> OIDC-discovery sequence on one base. */
async function probeBase(base: string): Promise<ProbeOutcome> {
  const apiBase = `${base}/api`;

  // 1) reachability + "is this a Chino server?"
  const health = await getJson<HealthDoc>(`${apiBase}/healthz`, PROBE_TIMEOUT_MS);
  if (!health) return { ok: false, kind: 'UNREACHABLE', detail: base };
  if (health.product !== 'chino') {
    return { ok: false, kind: 'NOT_CHINO', detail: health.product };
  }

  // 2) self-describing bootstrap config
  const cfg = await getJson<AppConfigDoc>(`${apiBase}/config`, PROBE_TIMEOUT_MS);
  const issuer = cfg?.oidcIssuer;
  if (!cfg || !issuer || issuer.trim() === '') {
    return { ok: false, kind: 'NO_CONFIG', detail: `${apiBase}/config` };
  }
  const clientId = clientIdFor(cfg);

  // 3) OIDC discovery against the advertised issuer
  const ep = await discover(issuer);
  if (!ep) return { ok: false, kind: 'DEVICE_GRANT_UNSUPPORTED', detail: issuer };

  // Prefer the server's self-reported apiBase when it carries a scheme — it is
  // the canonical external origin behind any reverse proxy. Otherwise use the
  // base we just probed against.
  const resolvedApiBase =
    cfg.apiBase && /^https?:\/\//.test(cfg.apiBase)
      ? cfg.apiBase.replace(/\/+$/, '')
      : apiBase;

  return {
    ok: true,
    config: {
      apiBase: resolvedApiBase,
      issuer: ep.issuer,
      clientId,
      deviceAuthEndpoint: ep.deviceAuthEndpoint,
      tokenEndpoint: ep.tokenEndpoint,
      userinfoEndpoint: ep.userinfoEndpoint,
    },
  };
}

/** A connected-but-wrong outcome is more informative than a plain UNREACHABLE
 *  that never connected. Mirrors ServerBootstrap.moreInformative. */
function moreInformative(
  current: { kind: BootstrapErrorKind; detail?: string } | null,
  next: { kind: BootstrapErrorKind; detail?: string },
): { kind: BootstrapErrorKind; detail?: string } {
  if (!current) return next;
  const currentConnected = current.kind !== 'UNREACHABLE';
  const nextConnected = next.kind !== 'UNREACHABLE';
  return !currentConnected && nextConnected ? next : current;
}

/**
 * Probes a user-entered server address and returns a resolved [ServerConfig].
 * Throws a [BootstrapError] (typed `kind`) on failure. Tries each candidate
 * origin; returns the FIRST that reaches a real Chino server. If the user
 * typed an explicit scheme we honour it: only fall back to the other scheme
 * when the typed one was UNREACHABLE (a scheme that connected but was wrong is
 * the intended endpoint — surface that immediately). Mirrors
 * ServerBootstrap.probe.
 */
export async function bootstrapServer(url: string): Promise<ServerConfig> {
  const bases = candidates(url);
  if (bases.length === 0) throw new BootstrapError('UNREACHABLE', 'empty URL');

  const trimmed = url.trim();
  const explicitScheme = trimmed.startsWith('http://') || trimmed.startsWith('https://');
  let best: { kind: BootstrapErrorKind; detail?: string } | null = null;

  for (let i = 0; i < bases.length; i++) {
    const outcome = await probeBase(bases[i]);
    if (outcome.ok) return outcome.config;
    best = moreInformative(best, outcome);
    if (explicitScheme && i === 0 && outcome.kind !== 'UNREACHABLE') {
      throw new BootstrapError(outcome.kind, outcome.detail);
    }
  }

  const fail = best ?? { kind: 'UNREACHABLE' as BootstrapErrorKind, detail: bases[0] };
  throw new BootstrapError(fail.kind, fail.detail);
}
