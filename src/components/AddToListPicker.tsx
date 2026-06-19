// Modal overlay for adding/removing an item to/from the user's named lists.
// The 10-foot, D-pad-driven counterpart of chino-web's AddToListPicker
// popover: one focusable row per list with a check box (checked = the item is
// in that list), toggling a row flips membership, and a "New list…" row opens
// the on-screen keyboard to create a list (the item is added to it on create).
//
// Membership is derived once on open by walking the user's lists and asking
// each whether it contains this item — chino-api exposes no batch memberships
// endpoint through the typed client (the web client's /memberships is not on
// the @/api/client contract), so we read each list's items via getWatchlist.
// Toggles are optimistic (flip the local set immediately, then fire the
// add/remove); the keyboard handles list-name entry exactly like the rest of
// the shell. BACK / a Done row dismiss.
//
// The caller owns open/close state (renders this only while open) and gets an
// optional onChanged callback so it can refresh its own list counts/shelves.

import { useEffect, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import type { Watchlist } from '@/api/types';
import { api } from '@/api/instance';
import { useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import KeyboardOverlay from './KeyboardOverlay';
import { Spinner } from './Spinner';

interface AddToListPickerProps {
  /** The catalogue item being filed. */
  itemId: string;
  /** Title shown in the overlay header (purely cosmetic). */
  itemTitle?: string;
  /** Dismiss the overlay (BACK / Done / Close). */
  onClose: () => void;
  /** Fired after any membership/list change lands so the host can refresh. */
  onChanged?: () => void;
}

export default function AddToListPicker({
  itemId,
  itemTitle,
  onClose,
  onChanged,
}: AddToListPickerProps): JSX.Element {
  const [lists, setLists] = useState<Watchlist[] | null>(null);
  // Which list ids currently contain this item (the check-box state).
  const [memberOf, setMemberOf] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // BACK dismisses (the keyboard, when open, owns its own BACK to close itself
  // first because it mounts a more-recent useRemoteKey subscriber).
  useRemoteKey(TVKey.BACK, () => {
    if (creating) {
      setCreating(false);
      return;
    }
    onClose();
  });

  // Load the lists + compute membership for this item. Each list's detail
  // carries the items it holds, so a parallel walk yields the membership set
  // without a dedicated endpoint. Default list first (the client already
  // orders /me/watchlists that way).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await api.listWatchlists();
        const present = new Set<string>();
        await Promise.all(
          all.map(async (l) => {
            try {
              const { items } = await api.getWatchlist(l.id);
              if (items.some((it) => it.id === itemId)) present.add(l.id);
            } catch {
              // A single list failing to hydrate just leaves it unchecked.
            }
          }),
        );
        if (cancelled) return;
        setLists(all);
        setMemberOf(present);
      } catch {
        if (!cancelled) {
          setLists([]);
          setError("Couldn't load your lists.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  // Toggle membership in one list, optimistically. On failure we revert the
  // local flip so the box reflects reality.
  const toggle = async (listId: string, present: boolean): Promise<void> => {
    setMemberOf((prev) => {
      const next = new Set(prev);
      if (present) next.add(listId);
      else next.delete(listId);
      return next;
    });
    try {
      if (present) await api.addToWatchlist(listId, itemId);
      else await api.removeFromWatchlist(listId, itemId);
      onChanged?.();
    } catch {
      setMemberOf((prev) => {
        const next = new Set(prev);
        if (present) next.delete(listId);
        else next.add(listId);
        return next;
      });
    }
  };

  // Create a new list, then drop this item into it.
  const submitNew = async (): Promise<void> => {
    const name = newName.trim();
    if (!name) {
      setError('Enter a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createWatchlist(name);
      await api.addToWatchlist(created.id, itemId);
      setLists((prev) => (prev ? [...prev, created] : [created]));
      setMemberOf((prev) => new Set(prev).add(created.id));
      setNewName('');
      setCreating(false);
      onChanged?.();
    } catch {
      setError("Couldn't create that list.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 px-8">
      <div className="flex w-[34rem] max-h-[80vh] flex-col overflow-hidden rounded-xl border border-border-2 bg-surface shadow-2xl">
        {/* Header — "Add to list" + the item title + a Close affordance. */}
        <div className="flex items-center justify-between border-b border-border-2 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-text">Add to list</h2>
            {itemTitle ? (
              <p className="mt-0.5 truncate text-sm text-muted">{itemTitle}</p>
            ) : null}
          </div>
          <CloseButton onEnter={onClose} />
        </div>

        {/* Body — the list rows + the create row. Scrolls if it overflows
            (focus-driven scrollIntoView keeps the focused row visible). */}
        <div className="flex-1 overflow-y-auto py-2">
          {lists == null ? (
            <div className="py-8">
              <Spinner label="Loading your lists…" fullscreen={false} />
            </div>
          ) : (
            <ul>
              {lists.map((list, i) => (
                <ListRow
                  key={list.id}
                  list={list}
                  checked={memberOf.has(list.id)}
                  autoFocus={i === 0}
                  onEnter={() => void toggle(list.id, !memberOf.has(list.id))}
                />
              ))}
              <li className="mt-1 border-t border-border-2 pt-1">
                <NewListRow autoFocus={lists.length === 0} onEnter={() => setCreating(true)} />
              </li>
            </ul>
          )}

          {error ? <p className="px-6 py-2 text-sm text-[#DA3633]">{error}</p> : null}
        </div>
      </div>

      {/* New-list name entry — the shared on-screen QWERTY, same as Add-Server /
          Search. Submitting creates the list and files the item. */}
      {creating ? (
        <KeyboardOverlay
          value={newName}
          onChange={setNewName}
          onSubmit={() => void submitNew()}
          onClose={() => setCreating(false)}
          title={busy ? 'Creating…' : 'New list'}
          placeholder="List name"
        />
      ) : null}
    </div>
  );
}

/** A single list row — label + Default badge + a check box reflecting whether
 *  the item is in this list. ENTER toggles. */
function ListRow({
  list,
  checked,
  autoFocus,
  onEnter,
}: {
  list: Watchlist;
  checked: boolean;
  autoFocus?: boolean;
  onEnter: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus });
  return (
    <li>
      <div
        ref={ref}
        data-focused={focused}
        className={`mx-3 flex cursor-default select-none items-center gap-4 rounded-lg px-4 py-3 transition-colors ${
          focused ? 'bg-surface-2' : ''
        }`}
      >
        {/* Check box — accent-green fill when the item is in this list. */}
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-2 ${
            checked ? 'border-signal-green bg-signal-green' : 'border-border-2 bg-transparent'
          }`}
        >
          {checked ? <Check className="h-4 w-4 stroke-[3] text-white" /> : null}
        </span>
        <span className="flex-1 truncate text-lg text-text">{list.name}</span>
        {list.is_default ? (
          <span className="shrink-0 text-xs uppercase tracking-wide text-muted">Default</span>
        ) : null}
      </div>
    </li>
  );
}

/** The "+ New list…" action row. */
function NewListRow({
  autoFocus,
  onEnter,
}: {
  autoFocus?: boolean;
  onEnter: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={`mx-3 flex cursor-default select-none items-center gap-3 rounded-lg px-4 py-3 text-accent transition-colors ${
        focused ? 'bg-surface-2' : ''
      }`}
    >
      <Plus className="h-5 w-5 shrink-0" />
      <span className="text-lg">New list…</span>
    </div>
  );
}

/** Header close button. */
function CloseButton({ onEnter }: { onEnter: () => void }): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter });
  return (
    <div
      ref={ref}
      data-focused={focused}
      aria-label="Close"
      title="Close"
      className={`flex h-10 w-10 shrink-0 cursor-default items-center justify-center rounded-lg transition-colors ${
        focused ? 'bg-surface-2' : ''
      }`}
    >
      <X className="h-5 w-5 text-muted" />
    </div>
  );
}
