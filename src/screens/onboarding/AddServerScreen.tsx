// First-run "connect to your server" screen for the neutral self-host client.
// The user types their server address (on-screen QWERTY), or one-taps a recent.
// On submit we probe the server (bootstrapServer: healthz → /api/config → OIDC
// discovery) and, on success, persist the resolved config + record the URL in
// recents, then advance to device-flow sign-in. Mirrors chino-androidtv
// ui/onboarding/ServerSetupScreen.kt + ServerSetupViewModel.kt.

import { useState } from 'react';
import { bootstrapServer, normalize } from '@/auth/bootstrap';
import { BootstrapError, type BootstrapErrorKind } from '@/auth/types';
import KeyboardOverlay from '@/components/KeyboardOverlay';
import { FocusButton, OnboardingSpinner } from './shared';
import { useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { navigate, back } from '@/router';
import { serverConfigStore } from '@/state/serverConfig';

/** Human-readable copy per failure kind. Mirrors ServerSetupViewModel.messageFor. */
function messageFor(kind: BootstrapErrorKind): string {
  switch (kind) {
    case 'UNREACHABLE':
      return "Couldn't reach that server. Check the address and that it's online.";
    case 'NOT_CHINO':
      return "That address responded, but it doesn't look like a Chino server.";
    case 'NO_CONFIG':
      return 'Server reachable, but it didn’t return its configuration (/api/config).';
    case 'DEVICE_GRANT_UNSUPPORTED':
      return "This server’s login provider doesn’t support TV sign-in (device flow).";
    default:
      return 'Something went wrong connecting to that server.';
  }
}

interface AddServerScreenProps {
  /** Settings "Change server" entry — shows a Cancel affordance back-out. On
   *  the first-run path there's nowhere to cancel to, so leave undefined. */
  onCancel?: () => void;
  /** Whether this is the change-server variant (affects heading copy). */
  changeServer?: boolean;
}

export default function AddServerScreen({ onCancel, changeServer }: AddServerScreenProps): JSX.Element {
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // recents()/addRecent() are a convenience the store MAY provide (mirrors
  // androidtv ServerConfigStore.recents). The build contract only pins
  // get/set/clear on @/state's serverConfigStore, so we feature-detect through
  // a structural view rather than hard-depend on those members — the screen
  // still works if the implementation ships only get/set/clear.
  const recentsApi = serverConfigStore as unknown as {
    recents?: () => string[];
    addRecent?: (url: string) => void;
  };
  const recents: string[] = recentsApi.recents ? recentsApi.recents() : [];

  // BACK: cancel the change-server flow if allowed, else just pop the route.
  useRemoteKey(TVKey.BACK, () => {
    if (editing) {
      setEditing(false);
      return;
    }
    if (onCancel) onCancel();
    else back();
  });

  const connect = async (raw: string): Promise<void> => {
    if (probing || raw.trim() === '') return;
    setProbing(true);
    setError(null);
    try {
      const config = await bootstrapServer(raw);
      serverConfigStore.set(config);
      recentsApi.addRecent?.(normalize(raw));
      // Advance to device-flow sign-in.
      navigate('/');
    } catch (e) {
      const kind = e instanceof BootstrapError ? e.kind : 'UNREACHABLE';
      setError(messageFor(kind));
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-16">
      <div className="flex w-[40rem] flex-col items-center gap-5">
        <h1 className="text-3xl font-semibold text-text">
          {changeServer ? 'Change server' : 'Connect to your server'}
        </h1>
        <p className="text-center text-muted">Enter the address of your Chino server.</p>

        {/* URL field — focusable; ENTER opens the on-screen keyboard. */}
        <UrlField value={url} onEnter={() => setEditing(true)} />

        <FocusButton onEnter={() => void connect(url)} disabled={probing || url.trim() === ''} autoFocus>
          {probing ? 'Connecting…' : 'Connect'}
        </FocusButton>

        {probing ? <OnboardingSpinner /> : null}

        {error ? <p className="text-center text-[#DA3633]">{error}</p> : null}

        {recents.length > 0 ? (
          <div className="flex w-full flex-col items-start gap-2">
            <span className="text-sm text-muted">Recent</span>
            {recents.map((r) => (
              <FocusButton
                key={r}
                onEnter={() => {
                  setUrl(r);
                  void connect(r);
                }}
                disabled={probing}
                full
              >
                {r.replace(/^https?:\/\//, '')}
              </FocusButton>
            ))}
          </div>
        ) : null}

        {onCancel ? (
          <FocusButton onEnter={onCancel} disabled={probing} full>
            Cancel
          </FocusButton>
        ) : null}
      </div>

      {editing ? (
        <KeyboardOverlay
          value={url}
          onChange={setUrl}
          onSubmit={() => {
            setEditing(false);
            void connect(url);
          }}
          onClose={() => setEditing(false)}
          title="Server address"
          placeholder="https://media.example.com"
        />
      ) : null}
    </div>
  );
}

/** Read-only display of the typed URL; activating it opens the keyboard. */
function UrlField({ value, onEnter }: { value: string; onEnter: () => void }): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter });
  return (
    <button
      ref={ref}
      type="button"
      data-focused={focused}
      className="flex h-14 w-full items-center rounded-lg border-2 border-border-2 bg-surface px-4 text-left text-xl outline-none"
    >
      {value ? (
        <span className="break-all text-text">{value}</span>
      ) : (
        <span className="text-muted">https://media.example.com</span>
      )}
    </button>
  );
}
