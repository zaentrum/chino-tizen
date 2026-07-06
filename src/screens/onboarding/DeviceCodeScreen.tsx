// Device-flow sign-in screen. Reads the connected server's config, starts an
// RFC 8628 device authorization, displays the user_code + verification_uri
// (the user opens it on their phone), and polls until approval. On success it
// fetches userinfo to populate the Account (real `sub` so re-signing the same
// user updates in place, not duplicates) and makes it active. Mirrors
// chino-androidtv ui/auth/DeviceCodeScreen.kt + AuthViewModel.kt.

import { useEffect, useRef, useState } from 'react';
import { startDeviceFlow, fetchUserInfo, bestDisplayName, DeviceAuthError } from '@/auth/deviceFlow';
import { authStore } from '@/auth/session';
import type { Account, ServerConfig, Tokens } from '@/auth/types';
import { FocusButton, OnboardingSpinner } from './shared';
import { useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { navigate, back } from '@/router';
import { serverConfigStore } from '@/state/serverConfig';

type State =
  | { phase: 'starting' }
  | { phase: 'waiting'; userCode: string; verificationUri: string; verificationUriComplete?: string }
  | { phase: 'done' }
  | { phase: 'error'; message: string };

/** Human-readable copy for a terminal device-flow error. Mirrors
 *  AuthViewModel's error mapping. */
function deviceErrorMessage(e: unknown): string {
  if (e instanceof DeviceAuthError) {
    switch (e.errorCode) {
      case 'expired_token':
        return 'The code expired. Please try again.';
      case 'access_denied':
        return 'Sign-in was cancelled.';
      default:
        return `Sign-in failed: ${e.errorCode}`;
    }
  }
  return e instanceof Error ? e.message : 'Sign-in failed.';
}

/** Turns a completed device-flow token bundle + the server config into a
 *  persisted, active Account. Hits userinfo for the stable `sub`/name/email;
 *  falls back to a synthetic id if that round-trip fails. Mirrors
 *  AuthViewModel's account assembly. */
async function completeSignIn(cfg: ServerConfig, tokens: Tokens): Promise<void> {
  const info = cfg.userinfoEndpoint
    ? await fetchUserInfo(cfg.userinfoEndpoint, tokens.access_token)
    : null;
  const account: Account = {
    sub: info?.sub ?? `anon-${Date.now()}`,
    name: info ? bestDisplayName(info) : 'Account',
    email: info?.email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 0) * 1000,
  };
  authStore.addOrUpdate(account, true);
}

export default function DeviceCodeScreen(): JSX.Element {
  const [state, setState] = useState<State>({ phase: 'starting' });
  // Bumping this re-runs the start effect (retry button).
  const [attempt, setAttempt] = useState(0);
  // Guards against a poll resolving after the component has unmounted / a
  // newer attempt has begun.
  const liveAttempt = useRef(0);

  useRemoteKey(TVKey.BACK, () => back());

  useEffect(() => {
    const cfg = serverConfigStore.get();
    if (!cfg) {
      // No server connected — bounce back to onboarding.
      navigate('/');
      return;
    }
    const myAttempt = attempt + 1;
    liveAttempt.current = myAttempt;
    let cancelled = false;

    void (async () => {
      setState({ phase: 'starting' });
      try {
        const handle = await startDeviceFlow(cfg);
        if (cancelled || liveAttempt.current !== myAttempt) return;
        setState({
          phase: 'waiting',
          userCode: handle.user_code,
          verificationUri: handle.verification_uri,
          verificationUriComplete: handle.verification_uri_complete,
        });
        const tokens = await handle.poll();
        if (cancelled || liveAttempt.current !== myAttempt) return;
        await completeSignIn(cfg, tokens);
        if (cancelled || liveAttempt.current !== myAttempt) return;
        setState({ phase: 'done' });
        navigate('/');
      } catch (e) {
        if (cancelled || liveAttempt.current !== myAttempt) return;
        setState({ phase: 'error', message: deviceErrorMessage(e) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <div className="flex min-h-screen items-center justify-center p-16">
      <div className="flex flex-col items-center gap-6">
        <h1 className="text-3xl font-semibold text-text">Sign in</h1>

        {state.phase === 'starting' || state.phase === 'done' ? <OnboardingSpinner /> : null}

        {state.phase === 'waiting' ? (
          <div className="flex flex-col items-center gap-5">
            <p className="text-center text-muted">
              On your phone or computer, open
            </p>
            <p className="text-2xl text-accent">{state.verificationUri}</p>
            <p className="text-center text-muted">and enter this code:</p>
            <CodeChips code={state.userCode} />
            <p className="mt-2 text-center text-sm text-muted">
              Waiting for you to sign in…
            </p>
          </div>
        ) : null}

        {state.phase === 'error' ? (
          <div className="flex flex-col items-center gap-4">
            <p className="max-w-xl text-center text-red">{state.message}</p>
            <FocusButton onEnter={() => setAttempt((n) => n + 1)} autoFocus>
              Try again
            </FocusButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Renders each code character as a large, room-readable chip. Mirrors the
 *  CodeChips affordance in androidtv DeviceCodeScreen.kt. */
function CodeChips({ code }: { code: string }): JSX.Element {
  return (
    <div className="flex gap-2">
      {code.split('').map((c, i) => (
        <div
          key={`${c}-${i}`}
          className="flex h-[4.5rem] w-14 items-center justify-center rounded-lg border border-border-2 bg-surface-2 text-4xl font-bold text-text"
        >
          {c}
        </div>
      ))}
    </div>
  );
}
