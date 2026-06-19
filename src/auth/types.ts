// Shared auth types for the neutral self-host TV client. These mirror the
// chino-androidtv data layer (data/ServerBootstrap.kt, data/auth/Account.kt,
// data/auth/OidcDeviceClient.kt) so behaviour stays in parity across clients.

/**
 * A single signed-in OIDC user. `sub` is the IdP `sub` claim — stable across
 * logins for the same user, so re-running the device flow on an existing
 * account updates the tokens in place rather than creating a duplicate row in
 * the account picker. Mirrors androidtv Account.kt (its `id` == our `sub`).
 */
export interface Account {
  sub: string;
  name: string;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry, epoch millis. 0 forces an immediate refresh attempt. */
  expiresAt: number;
}

/** Raw OAuth/OIDC token-endpoint response (snake_case wire fields). */
export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
}

/**
 * The server this client is connected to, fully resolved by [bootstrapServer]:
 * the API base origin, the advertised OIDC issuer + public client id, and the
 * concrete device-authorization + token endpoints discovered from the issuer's
 * .well-known metadata. Persisted by serverConfigStore (owned by @/state).
 *
 * Mirrors androidtv ServerConfig.kt, minus the userinfo endpoint which we keep
 * internally on the device-flow client.
 */
export interface ServerConfig {
  /** External API base, e.g. "https://media.example.com/api". No trailing slash. */
  apiBase: string;
  issuer: string;
  clientId: string;
  deviceAuthEndpoint: string;
  tokenEndpoint: string;
  /** OIDC userinfo endpoint, resolved from discovery (used to populate Account). */
  userinfoEndpoint?: string;
}

/**
 * Distinct bootstrap failure kinds so the Add-Server UI can show an actionable
 * message instead of a generic stack trace. Mirrors androidtv
 * BootstrapResult.Fail.Kind, with TLS folded into UNREACHABLE on the web (a
 * browser fetch surfaces a cert problem as a generic network TypeError — we
 * cannot distinguish it, unlike OkHttp's SSLException).
 */
export type BootstrapErrorKind =
  | 'UNREACHABLE'
  | 'NOT_CHINO'
  | 'NO_CONFIG'
  | 'DEVICE_GRANT_UNSUPPORTED';

/** Typed error thrown by [bootstrapServer]; carries the kind + optional detail. */
export class BootstrapError extends Error {
  readonly kind: BootstrapErrorKind;
  readonly detail?: string;
  constructor(kind: BootstrapErrorKind, detail?: string) {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
    this.name = 'BootstrapError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** RFC 8628 device-authorization response (snake_case wire fields). */
export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  /** Poll interval seconds; defaults to 5 when the IdP omits it. */
  interval: number;
}

/** Identity claims read from the OIDC userinfo endpoint. */
export interface UserInfo {
  sub: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  given_name?: string;
  family_name?: string;
}
