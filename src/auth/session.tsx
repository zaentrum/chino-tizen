// Multi-account session store + React binding for the neutral self-host TV
// client. Persists a list of [Account] records + the active account `sub` in
// localStorage, and refreshes the active account's access token in the
// background before it expires. Mirrors chino-androidtv data/auth/AccountStore.kt
// + data/auth/TokenManager.kt (web has no keystore-backed encrypted prefs, so
// we use plain localStorage — the same trust model as chino-web's oidc-client-ts
// user store).

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { refreshTokens } from './deviceFlow';
import type { Account, ServerConfig, Tokens } from './types';

// localStorage keys. The server config is written by @/state's
// serverConfigStore; the session reads it (token endpoint + client id) to
// drive refresh. SERVER_CONFIG_KEY MUST match @/state/serverConfig.ts's KEY
// ('chino.serverConfig') so both modules see the same connected server.
const ACCOUNTS_KEY = 'chino.auth.accounts.v1';
const SERVER_CONFIG_KEY = 'chino.serverConfig';

// Refresh once we're within 60s of expiry. Mirrors TokenManager.REFRESH_SLACK_MS.
const REFRESH_SLACK_MS = 60_000;

interface AccountsBlob {
  accounts: Account[];
  activeSub: string | null;
}

function readBlob(): AccountsBlob {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) return { accounts: [], activeSub: null };
    const parsed = JSON.parse(raw) as Partial<AccountsBlob>;
    return {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      activeSub: parsed.activeSub ?? null,
    };
  } catch {
    return { accounts: [], activeSub: null };
  }
}

function writeBlob(blob: AccountsBlob): void {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(blob));
  } catch {
    /* storage full / disabled — in-memory state still drives the session */
  }
}

/** Reads the persisted server config (written by @/state.serverConfigStore).
 *  Returns null before any server has been connected. */
function readServerConfig(): ServerConfig | null {
  try {
    const raw = localStorage.getItem(SERVER_CONFIG_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ServerConfig;
  } catch {
    return null;
  }
}

type Listener = () => void;

/**
 * The session singleton. Holds the account list + active sub in memory
 * (seeded from localStorage), notifies subscribers on every mutation, and
 * exposes the synchronous getters the API client + image/video URLs need:
 * getToken() / getApiBase(). Token refresh is single-flight per account.
 */
class AuthStore {
  private blob: AccountsBlob = readBlob();
  private listeners = new Set<Listener>();
  // In-flight refresh promises keyed by account sub — single-flight so a burst
  // of API calls all await one refresh instead of stampeding the token endpoint.
  private refreshing = new Map<string, Promise<string | null>>();

  // --- subscription -------------------------------------------------------
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // --- snapshots (used by useSyncExternalStore-style consumers) -----------
  getAccounts(): Account[] {
    return this.blob.accounts;
  }

  getActiveAccount(): Account | null {
    return this.blob.accounts.find((a) => a.sub === this.blob.activeSub) ?? null;
  }

  // --- synchronous getters for the API client / media URLs ----------------
  /** Bearer token for the active account, or null. Does NOT block on refresh —
   *  the background timer keeps it fresh; the API client also re-reads after a
   *  401 via [forceRefresh]. */
  getToken(): string | null {
    return this.getActiveAccount()?.accessToken ?? null;
  }

  /** The connected server's API base ("https://host/api"), or null before a
   *  server has been added. Read from the persisted ServerConfig. */
  getApiBase(): string | null {
    return readServerConfig()?.apiBase ?? null;
  }

  // --- mutations ----------------------------------------------------------
  /** Append a new account or update tokens of an existing one (matched by
   *  sub). setActive=true makes it the current account after sign-in.
   *  Mirrors AccountStore.addOrUpdate. */
  addOrUpdate(account: Account, setActive = false): void {
    const without = this.blob.accounts.filter((a) => a.sub !== account.sub);
    this.blob = {
      accounts: [...without, account],
      activeSub: setActive ? account.sub : this.blob.activeSub,
    };
    this.persistAndEmit();
  }

  /** Sets the active account (no-op if unknown). Mirrors AccountStore.setActive. */
  setActive(sub: string): void {
    if (!this.blob.accounts.some((a) => a.sub === sub)) return;
    this.blob = { ...this.blob, activeSub: sub };
    this.persistAndEmit();
  }

  /** Removes an account; if it was active, falls back to the first remaining.
   *  Mirrors AccountStore.remove. */
  remove(sub: string): void {
    const accounts = this.blob.accounts.filter((a) => a.sub !== sub);
    const activeSub =
      this.blob.activeSub === sub ? (accounts[0]?.sub ?? null) : this.blob.activeSub;
    this.blob = { accounts, activeSub };
    this.persistAndEmit();
  }

  /** Signs out the active account (removes it). The host routes to onboarding /
   *  the picker when no account remains. */
  signOut(): void {
    const active = this.blob.activeSub;
    if (active) this.remove(active);
  }

  /** Replaces just the token fields on the named account; preserves
   *  name/email/sub. Scoped by sub (not "active") so a mid-refresh account
   *  switch can't corrupt the new account's tokens. Mirrors
   *  AccountStore.updateTokensForBlocking. */
  private updateTokensFor(sub: string, tokens: Tokens): Account | null {
    let updated: Account | null = null;
    const accounts = this.blob.accounts.map((a) => {
      if (a.sub !== sub) return a;
      updated = {
        ...a,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? a.refreshToken,
        expiresAt: Date.now() + (tokens.expires_in ?? 0) * 1000,
      };
      return updated;
    });
    this.blob = { ...this.blob, accounts };
    this.persistAndEmit();
    return updated;
  }

  private persistAndEmit(): void {
    writeBlob(this.blob);
    this.emit();
  }

  // --- token refresh ------------------------------------------------------
  /**
   * Refreshes the active account's token if it is within REFRESH_SLACK_MS of
   * expiry. Single-flight per account. Returns the (possibly refreshed) access
   * token, or null when there's nothing valid to return. Mirrors
   * TokenManager.validAccessTokenBlocking.
   */
  async ensureFreshToken(): Promise<string | null> {
    const current = this.getActiveAccount();
    if (!current) return null;
    if (Date.now() < current.expiresAt - REFRESH_SLACK_MS) return current.accessToken;
    return this.refreshAccount(current.sub);
  }

  /** Forces a refresh of the active account regardless of expiry — the API
   *  client's 401 recovery path. Mirrors TokenManager.forceRefreshBlocking. */
  async forceRefresh(): Promise<string | null> {
    const active = this.blob.activeSub;
    if (!active) return null;
    return this.refreshAccount(active, true);
  }

  private refreshAccount(sub: string, force = false): Promise<string | null> {
    const existing = this.refreshing.get(sub);
    if (existing) return existing;

    const run = (async (): Promise<string | null> => {
      const account = this.blob.accounts.find((a) => a.sub === sub);
      if (!account) return null;
      if (!force && Date.now() < account.expiresAt - REFRESH_SLACK_MS) {
        return account.accessToken;
      }
      const rt = account.refreshToken;
      const cfg = readServerConfig();
      if (!rt || !cfg) return null;
      const refreshed = await refreshTokens(
        { tokenEndpoint: cfg.tokenEndpoint, clientId: cfg.clientId },
        rt,
      );
      if (!refreshed) return null;
      const updated = this.updateTokensFor(sub, refreshed);
      return updated?.accessToken ?? null;
    })().finally(() => {
      this.refreshing.delete(sub);
    });

    this.refreshing.set(sub, run);
    return run;
  }
}

export const authStore = new AuthStore();

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

export type AuthStatus = 'loading' | 'unauthed' | 'authed';

interface AuthContextValue {
  status: AuthStatus;
  account: Account | null;
  accounts: Account[];
  signOut(): void;
  switchAccount(sub: string): void;
  signIn(tokens: Tokens): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Decodes a JWT payload without verifying the signature — used only to derive
 * an account `sub`/name/email when signing in via raw [Tokens] (e.g. the
 * device-flow result before a userinfo round-trip). Never trusted for
 * authorization; the server verifies the token on every request.
 */
function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Builds an Account from a token bundle, preferring an explicit id_token's
 *  claims, falling back to the access token, then to a synthetic sub. */
function accountFromTokens(tokens: Tokens): Account {
  const claims = decodeJwt(tokens.id_token ?? tokens.access_token) ?? {};
  const sub =
    typeof claims.sub === 'string' && claims.sub !== ''
      ? claims.sub
      : `anon-${Date.now()}`;
  const name =
    (typeof claims.name === 'string' && claims.name) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
    (typeof claims.email === 'string' && claims.email.split('@')[0]) ||
    'Account';
  const email = typeof claims.email === 'string' ? claims.email : undefined;
  return {
    sub,
    name,
    email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 0) * 1000,
  };
}

/**
 * Provider — wraps the app, subscribes to the singleton, runs the background
 * refresh timer. The integrator mounts this near the root; screens read state
 * via [useAuth]. (Standalone consumers can also call the singleton directly.)
 */
export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  // Local mirror of the singleton, bumped on every store emit.
  const [, force] = useState(0);
  useEffect(() => authStore.subscribe(() => force((n) => n + 1)), []);

  // Background refresh: every 30s, top up the active account's token if it is
  // close to expiry. Cheap no-op when nothing's near expiry.
  useEffect(() => {
    const id = window.setInterval(() => {
      void authStore.ensureFreshToken();
    }, 30_000);
    // Eager first pass so a token that expired while the app was closed is
    // refreshed before the first screen's data load.
    void authStore.ensureFreshToken();
    return () => window.clearInterval(id);
  }, []);

  const accounts = authStore.getAccounts();
  const account = authStore.getActiveAccount();
  const status: AuthStatus = account ? 'authed' : 'unauthed';

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      account,
      accounts,
      signOut: () => authStore.signOut(),
      switchAccount: (sub: string) => authStore.setActive(sub),
      signIn: (tokens: Tokens) => authStore.addOrUpdate(accountFromTokens(tokens), true),
    }),
    // account/accounts identities change on every emit (force re-render), so
    // depending on them keeps the memo honest without a manual revision counter.
    [status, account, accounts],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Reads the auth state. Works whether or not an [AuthProvider] is mounted: if
 * there's no provider it falls back to a self-subscribing view of the
 * singleton, so onboarding screens (which the integrator may mount before the
 * provider) still react to sign-in. status is 'authed' once an account exists.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  // Always call hooks unconditionally (rules of hooks); the fallback view is
  // only WIRED UP when there's no provider.
  const [, force] = useState(0);
  useEffect(() => {
    if (ctx) return;
    return authStore.subscribe(() => force((n) => n + 1));
  }, [ctx]);

  if (ctx) return ctx;

  const account = authStore.getActiveAccount();
  return {
    status: account ? 'authed' : 'unauthed',
    account,
    accounts: authStore.getAccounts(),
    signOut: () => authStore.signOut(),
    switchAccount: (sub: string) => authStore.setActive(sub),
    signIn: (tokens: Tokens) => authStore.addOrUpdate(accountFromTokens(tokens), true),
  };
}
