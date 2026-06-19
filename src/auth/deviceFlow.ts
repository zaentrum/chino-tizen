// RFC 8628 OAuth 2.0 Device Authorization Grant with PKCE (S256) against the
// server's OIDC provider. Mirrors chino-androidtv data/auth/OidcDeviceClient.kt.
//
// Flow:
//   1) startDeviceFlow(cfg) — POST {deviceAuthEndpoint} with client_id + scope
//      + PKCE code_challenge → returns a user_code we display on the TV plus a
//      verification_uri the user opens on their phone.
//   2) poll() — POST {tokenEndpoint} grant_type=device_code (replaying the
//      PKCE code_verifier) every `interval` seconds until we get tokens, the
//      user approves/denies, or the code expires.

import type { DeviceAuthorization, ServerConfig, Tokens } from './types';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_SCOPE = 'openid profile email offline_access';

/** Thrown for a non-recoverable device-flow error (expired_token,
 *  access_denied, server error). Carries the OAuth `error` code so the UI can
 *  render an actionable message. Mirrors DeviceAuthException. */
export class DeviceAuthError extends Error {
  readonly errorCode: string;
  constructor(errorCode: string) {
    super(`OIDC device-flow error: ${errorCode}`);
    this.name = 'DeviceAuthError';
    this.errorCode = errorCode;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  id_token?: string;
}

interface OauthErrorDoc {
  error: string;
  error_description?: string;
}

/** base64url with no padding, per RFC 7636. */
function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Handle returned by [startDeviceFlow]. The screen shows `user_code` +
 * `verification_uri` (or the `verification_uri_complete` QR), then awaits
 * `poll()`, which resolves with [Tokens] once the user approves or rejects
 * with a [DeviceAuthError] on a terminal failure.
 */
export interface DeviceFlowHandle {
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  /** Poll interval seconds (>= 1). */
  interval: number;
  /** Seconds until the user_code expires (for an on-screen countdown). */
  expires_in: number;
  poll(): Promise<Tokens>;
}

/**
 * Starts the device authorization request, mints a fresh PKCE verifier, and
 * returns a handle whose `poll()` drives the token poll. The verifier is
 * captured in the closure and replayed on every poll (the unified `chino`
 * client enforces S256). Single sign-in at a time per call, so a closure
 * field is sufficient. Mirrors startDeviceAuthorization + pollForTokens.
 */
export async function startDeviceFlow(
  cfg: ServerConfig,
  scope: string = DEFAULT_SCOPE,
): Promise<DeviceFlowHandle> {
  const verifier = newCodeVerifier();
  const challenge = await codeChallengeS256(verifier);

  const startBody = new URLSearchParams({
    client_id: cfg.clientId,
    scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const resp = await fetch(cfg.deviceAuthEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: startBody.toString(),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Device auth start failed: HTTP ${resp.status} — ${text}`);
  }
  const auth = JSON.parse(text) as DeviceAuthorization;

  let interval = Math.max(auth.interval ?? 5, 1);

  const poll = async (): Promise<Tokens> => {
    // OAuth device-flow uses 400 with an `error` field for
    // pending/slow-down/expired, and other 4xx/5xx for everything else. Parse
    // defensively. The caller cancels by simply not awaiting / unmounting.
    for (;;) {
      await sleep(interval * 1000);
      const body = new URLSearchParams({
        client_id: cfg.clientId,
        grant_type: DEVICE_GRANT,
        device_code: auth.device_code,
        code_verifier: verifier, // PKCE
      });
      const r = await fetch(cfg.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const payload = await r.text();
      if (r.status >= 200 && r.status < 300) {
        const tok = JSON.parse(payload) as TokenResponse;
        return {
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          expires_in: tok.expires_in ?? 0,
          id_token: tok.id_token,
        };
      }
      let errorCode: string | undefined;
      try {
        errorCode = (JSON.parse(payload) as OauthErrorDoc).error;
      } catch {
        errorCode = undefined;
      }
      switch (errorCode) {
        case 'authorization_pending':
          break; // keep polling
        case 'slow_down':
          interval += 5;
          break;
        case undefined:
          throw new Error(`Token poll failed: HTTP ${r.status} — ${payload}`);
        default:
          // expired_token / access_denied / any other OAuth error code.
          throw new DeviceAuthError(errorCode);
      }
    }
  };

  return {
    user_code: auth.user_code,
    verification_uri: auth.verification_uri,
    verification_uri_complete: auth.verification_uri_complete,
    interval,
    expires_in: auth.expires_in,
    poll,
  };
}

/**
 * Trades a refresh_token for a fresh access_token (+ rotated refresh_token).
 * Access-token TTLs are short (Keycloak defaults to 5 min) so without this
 * every API call past that boundary 401s. Returns null on any error so the
 * caller decides whether to drop to sign-in or retry later. Mirrors
 * OidcDeviceClient.refresh — used by the session token-refresh path.
 */
export async function refreshTokens(
  cfg: Pick<ServerConfig, 'tokenEndpoint' | 'clientId'>,
  refreshToken: string,
): Promise<Tokens | null> {
  try {
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const r = await fetch(cfg.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (r.status < 200 || r.status >= 300) return null;
    const tok = (await r.json()) as TokenResponse;
    return {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? refreshToken,
      expires_in: tok.expires_in ?? 0,
      id_token: tok.id_token,
    };
  } catch {
    return null;
  }
}

/**
 * Calls the OIDC userinfo endpoint to extract identity claims for a freshly
 * minted access token (sub → account id, name → display, email → avatar).
 * Returns null on any error. Mirrors OidcDeviceClient.fetchUserInfo.
 */
export async function fetchUserInfo(
  userinfoEndpoint: string,
  accessToken: string,
): Promise<import('./types').UserInfo | null> {
  try {
    const r = await fetch(userinfoEndpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status < 200 || r.status >= 300) return null;
    return (await r.json()) as import('./types').UserInfo;
  } catch {
    return null;
  }
}

/** Best-effort human label: name → preferred_username → email local-part →
 *  sub. Mirrors UserInfo.bestDisplayName. */
export function bestDisplayName(info: import('./types').UserInfo): string {
  if (info.name && info.name.trim() !== '') return info.name;
  if (info.preferred_username && info.preferred_username.trim() !== '') {
    return info.preferred_username;
  }
  const local = info.email?.split('@')[0];
  if (local && local.trim() !== '') return local;
  return info.sub;
}
