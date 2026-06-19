// "Who's watching?" — a horizontal row of account avatars + an "Add account"
// tile, for TVs with a shared remote. Selecting a tile makes that account
// active and proceeds to the library; the RED colour button on a focused
// account removes it (after a confirm), the D-pad-friendly stand-in for
// androidtv's long-press. Mirrors chino-androidtv ui/auth/AccountPickerScreen.kt.

import { useState } from 'react';
import { authStore, useAuth } from '@/auth/session';
import type { Account } from '@/auth/types';
import { FocusButton } from './shared';
import { useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { navigate, back } from '@/router';
import { Plus } from 'lucide-react';

export default function AccountPickerScreen(): JSX.Element {
  const { accounts } = useAuth();
  const [pendingRemoval, setPendingRemoval] = useState<Account | null>(null);

  useRemoteKey(TVKey.BACK, () => {
    if (pendingRemoval) {
      setPendingRemoval(null);
      return;
    }
    back();
  });

  const pick = (account: Account): void => {
    authStore.setActive(account.sub);
    navigate('/');
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 p-12">
      <h1 className="text-4xl font-semibold text-text">Who&apos;s watching?</h1>
      <p className="text-sm text-muted">
        Press the red button on an account to remove it.
      </p>

      <div className="flex flex-wrap items-center justify-center gap-8 pt-4">
        {accounts.map((account, i) => (
          <AccountTile
            key={account.sub}
            account={account}
            autoFocus={i === 0}
            onSelect={() => pick(account)}
            onRemove={() => setPendingRemoval(account)}
          />
        ))}
        <AddAccountTile onSelect={() => navigate('/')} />
      </div>

      {pendingRemoval ? (
        <ConfirmRemoveDialog
          account={pendingRemoval}
          onConfirm={() => {
            authStore.remove(pendingRemoval.sub);
            setPendingRemoval(null);
          }}
          onDismiss={() => setPendingRemoval(null)}
        />
      ) : null}
    </div>
  );
}

interface AccountTileProps {
  account: Account;
  autoFocus?: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

function AccountTile({ account, autoFocus, onSelect, onRemove }: AccountTileProps): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter: onSelect, autoFocus });
  // The RED colour key removes the focused account. Only acts when this tile
  // holds focus so the global listener targets the right account.
  useRemoteKey(TVKey.COLOR_RED, () => {
    if (focused) onRemove();
  });
  return (
    <button
      ref={ref}
      type="button"
      data-focused={focused}
      className="flex w-40 flex-col items-center gap-3 rounded-2xl p-2 outline-none"
    >
      <Avatar name={account.name} email={account.email} />
      <span className="max-w-full truncate text-lg font-medium text-text">{account.name}</span>
    </button>
  );
}

function AddAccountTile({ onSelect }: { onSelect: () => void }): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter: onSelect });
  return (
    <button
      ref={ref}
      type="button"
      data-focused={focused}
      className="flex w-40 flex-col items-center gap-3 rounded-2xl p-2 outline-none"
    >
      <div className="flex h-32 w-32 items-center justify-center rounded-full bg-surface-2">
        <Plus size={48} className="text-text" />
      </div>
      <span className="text-lg font-medium text-text">Add account</span>
    </button>
  );
}

/** Initial-on-coloured-circle avatar. We don't fetch a gravatar over the open
 *  internet on TV; the deterministic colour keeps tiles distinguishable.
 *  Mirrors the fallback in androidtv ui/auth/Avatar.kt. */
function Avatar({ name, email }: { name: string; email?: string }): JSX.Element {
  const seed = (email ?? name) || '?';
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  const hue = hashHue(seed);
  return (
    <div
      className="flex h-32 w-32 items-center justify-center rounded-full text-5xl font-semibold text-white"
      style={{ backgroundColor: `hsl(${hue}, 45%, 38%)` }}
    >
      {initial}
    </div>
  );
}

/** Stable 0-359 hue from a string — same input always yields the same colour. */
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

interface ConfirmRemoveDialogProps {
  account: Account;
  onConfirm: () => void;
  onDismiss: () => void;
}

function ConfirmRemoveDialog({ account, onConfirm, onDismiss }: ConfirmRemoveDialogProps): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="flex w-[26rem] flex-col items-center gap-4 rounded-2xl border border-border-2 bg-surface p-6">
        <Avatar name={account.name} email={account.email} />
        <h2 className="text-center text-xl font-semibold text-text">
          Remove {account.name}?
        </h2>
        <p className="text-center text-sm text-text">
          You&apos;ll need to sign in again to use this account on this TV.
        </p>
        <div className="flex gap-3">
          <FocusButton onEnter={onDismiss} autoFocus>
            Cancel
          </FocusButton>
          <FocusButton onEnter={onConfirm} variant="danger">
            Remove
          </FocusButton>
        </div>
      </div>
    </div>
  );
}
