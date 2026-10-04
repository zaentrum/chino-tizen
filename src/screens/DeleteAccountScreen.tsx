// Delete Account — reached from Settings → Account. A screen of its own (no
// rail, no top bar: nothing else to land on) that names the account and the
// server, says what goes and that it cannot be undone, and deletes only from
// the separate Delete Account button to the right of Cancel, where focus
// starts. BACK cancels, except while the request is out. Mirrors
// chino-androidtv's ui/settings/DeleteAccountScreen.kt.
//
// The answers (lib/account.ts): deleted → the account is signed out on this
// TV (authStore.remove: its tokens go; screens mint their own stream tokens)
// and the app starts over at '/', in place of this screen — the next
// account's home, or sign-in when it was the last; refused or not available
// here → the reason, and Close; any other → Try Again Later with the server's
// message, Delete Account still there to try again.

import { useRef, useState } from 'react';
import { useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { back, replace } from '@/router';
import { authStore, useAuth } from '@/auth/session';
import { serverConfigStore } from '@/state/serverConfig';
import { FocusButton } from './onboarding/shared';
import {
  accountDeletionTitle,
  deleteAccount,
  isFinal,
  type AccountDeletion,
} from '@/lib/account';

/** What deleting an account takes with it, as the screen lists it. */
const WHAT_GOES = [
  'your watch progress',
  'your lists',
  'your likes',
  'your watch history',
  "your sign-in: you can't sign in with this account again",
];

type Answer = Exclude<AccountDeletion, { kind: 'deleted' }>;

export default function DeleteAccountScreen(): JSX.Element {
  const { account } = useAuth();
  // The account this screen deletes: the one active when it opened.
  const [target] = useState(() => account);
  const [deleting, setDeleting] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const final = answer ? isFinal(answer) : false;
  // A remote can deliver one OK twice: one request at a time.
  const inFlight = useRef(false);

  useRemoteKey(TVKey.BACK, () => {
    if (!deleting) back();
  });

  const host = serverConfigStore.get()?.apiBase
    ?.replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const who = target?.email || target?.name;

  const confirm = async (): Promise<void> => {
    if (inFlight.current || final || !target) return;
    inFlight.current = true;
    setDeleting(true);
    setAnswer(null);
    // The bearer is the active account's: never send it for another one.
    const result: AccountDeletion =
      authStore.getActiveAccount()?.sub !== target.sub
        ? { kind: 'failed', message: 'Another account is signed in now. Open Delete Account again.' }
        : await deleteAccount({
            url: `${(authStore.getApiBase() ?? '').replace(/\/+$/, '')}/v1/me`,
            token: await authStore.ensureFreshToken(),
            renew: () => authStore.forceRefresh(),
          });
    if (result.kind === 'deleted') {
      // Gone on the server: sign it out here and start over.
      authStore.remove(target.sub);
      replace('/');
      return;
    }
    inFlight.current = false;
    setDeleting(false);
    setAnswer(result);
  };

  return (
    <main
      aria-labelledby="delete-account-title"
      className="flex min-h-screen items-center justify-center bg-bg px-24 py-16 text-text"
    >
      <div className="flex w-full max-w-4xl flex-col gap-6">
        <h1 id="delete-account-title" className="text-4xl font-bold text-fg">
          Delete Account
        </h1>
        <p className="text-xl">
          This deletes{' '}
          {who ? (
            <>
              the account <span className="font-semibold text-fg">{who}</span>
            </>
          ) : (
            'your account'
          )}{' '}
          on {host || 'this server'}, and with it:
        </p>
        <ul className="flex flex-col gap-2 pl-2 text-xl">
          {WHAT_GOES.map((line) => (
            <li key={line} className="flex items-center gap-4">
              <span aria-hidden="true" className="h-2 w-2 shrink-0 bg-muted" />
              {line}
            </li>
          ))}
        </ul>
        <p className="text-xl">This can&apos;t be undone.</p>

        {/* Progress, announced as it starts. */}
        <div role="status" aria-live="polite" className="text-lg text-muted">
          {deleting ? 'Deleting your account…' : null}
        </div>
        {answer ? (
          <div role="alert" className="flex flex-col gap-1">
            <p className="text-xl font-semibold text-red">{accountDeletionTitle(answer)}</p>
            <p className="text-lg">{answer.message}</p>
          </div>
        ) : null}

        <div className="flex items-center gap-4 pt-2">
          {/* Remounted (key) once the answer is final, so focus lands on
              Close when Delete Account goes away. */}
          <FocusButton
            key={final ? 'close' : 'cancel'}
            autoFocus
            onEnter={() => {
              if (!deleting) back();
            }}
          >
            {final ? 'Close' : 'Cancel'}
          </FocusButton>
          {!final ? (
            <FocusButton variant="danger" onEnter={() => void confirm()}>
              {deleting ? 'Deleting…' : 'Delete Account'}
            </FocusButton>
          ) : null}
        </div>
        {!final && !deleting ? (
          <p className="text-base text-muted">Press BACK to keep your account.</p>
        ) : null}
      </div>
    </main>
  );
}
