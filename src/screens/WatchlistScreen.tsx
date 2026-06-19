// The watchlist HUB — the cross-client lists surface (chino-web's
// WatchlistSection / chino-androidtv's WatchlistScreen.kt parity). Two views
// behind one route:
//
//   HUB  — a title + a "New list" chip, then one horizontal MediaRow per list
//          (the default list first, the rest as returned by /me/watchlists).
//          A "See all" card at the end of each shelf — and ENTER on the shelf's
//          focusable header — opens that list's MORE view.
//   MORE — the full poster grid for one list, with a back affordance and
//          rename (any list) + delete (non-default only) actions. BACK returns
//          to the hub.
//
// Data is the @/api watchlist methods: listWatchlists() for the hub, then
// getWatchlist(id) per list to hydrate its items (the membership endpoint only
// yields ids; the client hydrates them). Poster URLs are authorised with a
// stream token minted once on mount (artwork lives in chino-api's stream-token
// group). Create / rename use the shared on-screen keyboard. New lists, renames
// and deletes refresh the hub in place.

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Item, Watchlist } from '@/api/types';
import { api } from '@/api/instance';
import { SideRail } from '@/components/SideRail';
import { TopBar } from '@/components/TopBar';
import { FocusableCard } from '@/components/FocusableCard';
import { Spinner } from '@/components/Spinner';
import KeyboardOverlay from '@/components/KeyboardOverlay';
import { useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { navigate, back } from '@/router';

/** A list plus the items it holds (hydrated). `loading` is true while the
 *  per-list items fetch is in flight (the meta arrives first). */
interface ListEntry {
  list: Watchlist;
  items: Item[];
  loading: boolean;
}

/** The active name-entry overlay: creating a new list, or renaming one. */
type NameOverlay = { mode: 'create' } | { mode: 'rename'; list: Watchlist };

export default function WatchlistScreen(): JSX.Element {
  const [entries, setEntries] = useState<ListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamToken, setStreamToken] = useState<string | undefined>(undefined);
  // null = hub; a list id = that list's MORE (full-grid) view.
  const [openId, setOpenId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<NameOverlay | null>(null);
  const [name, setName] = useState('');

  // Mint a stream token for poster artwork (best-effort — posters degrade to a
  // placeholder if it fails).
  useEffect(() => {
    let cancelled = false;
    void api
      .streamToken()
      .then((t) => {
        if (!cancelled) setStreamToken(t);
      })
      .catch(() => {
        /* posters fall back to the card placeholder */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the lists, then hydrate each list's items. The meta lands first so the
  // shelves render with their titles immediately; items fill in per-list.
  const reload = useCallback(async () => {
    setError(null);
    try {
      const lists = await api.listWatchlists();
      setEntries(lists.map((list) => ({ list, items: [], loading: true })));
      await Promise.all(
        lists.map(async (list) => {
          try {
            const { list: meta, items } = await api.getWatchlist(list.id);
            setEntries((prev) =>
              prev
                ? prev.map((e) =>
                    e.list.id === list.id ? { list: meta, items, loading: false } : e,
                  )
                : prev,
            );
          } catch {
            setEntries((prev) =>
              prev
                ? prev.map((e) => (e.list.id === list.id ? { ...e, loading: false } : e))
                : prev,
            );
          }
        }),
      );
    } catch {
      setEntries([]);
      setError("Couldn't load your lists.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // BACK: from a MORE view return to the hub; from the hub pop the route.
  useRemoteKey(TVKey.BACK, () => {
    if (overlay) {
      setOverlay(null);
      return;
    }
    if (openId) {
      setOpenId(null);
      return;
    }
    back();
  });

  const openEntry = entries?.find((e) => e.list.id === openId) ?? null;

  // --- list mutations ------------------------------------------------------

  const createList = async (raw: string): Promise<void> => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      await api.createWatchlist(trimmed);
      await reload();
    } catch {
      setError("Couldn't create that list.");
    }
  };

  const renameList = async (id: string, raw: string): Promise<void> => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      await api.renameWatchlist(id, trimmed);
      await reload();
    } catch {
      setError("Couldn't rename that list.");
    }
  };

  const deleteList = async (id: string): Promise<void> => {
    try {
      await api.deleteWatchlist(id);
      setOpenId(null);
      await reload();
    } catch {
      setError("Couldn't delete that list.");
    }
  };

  const submitOverlay = (): void => {
    const current = overlay;
    setOverlay(null);
    if (!current) return;
    if (current.mode === 'create') void createList(name);
    else void renameList(current.list.id, name);
  };

  // --- render --------------------------------------------------------------

  return (
    <div className="flex h-screen w-full bg-bg text-text">
      <SideRail active="watchlist" />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 overflow-y-auto px-10 py-6">
          {entries == null ? (
            <Spinner label="Loading your lists…" />
          ) : openEntry ? (
            <MoreView
              entry={openEntry}
              streamToken={streamToken}
              onBack={() => setOpenId(null)}
              onSelect={(item) => navigate(`/detail/${item.id}`)}
              onRename={() => {
                setName(openEntry.list.name);
                setOverlay({ mode: 'rename', list: openEntry.list });
              }}
              onDelete={() => void deleteList(openEntry.list.id)}
            />
          ) : (
            <HubView
              entries={entries}
              streamToken={streamToken}
              error={error}
              onNewList={() => {
                setName('');
                setOverlay({ mode: 'create' });
              }}
              onOpenList={(id) => setOpenId(id)}
              onSelect={(item) => navigate(`/detail/${item.id}`)}
            />
          )}
        </main>
      </div>

      {/* Create / rename name entry — shared on-screen QWERTY. */}
      {overlay ? (
        <KeyboardOverlay
          value={name}
          onChange={setName}
          onSubmit={submitOverlay}
          onClose={() => setOverlay(null)}
          title={overlay.mode === 'create' ? 'New list' : 'Rename list'}
          placeholder="List name"
        />
      ) : null}
    </div>
  );
}

/* ──────────────────────────────  Hub  ───────────────────────────────────── */

function HubView({
  entries,
  streamToken,
  error,
  onNewList,
  onOpenList,
  onSelect,
}: {
  entries: ListEntry[];
  streamToken?: string;
  error: string | null;
  onNewList: () => void;
  onOpenList: (id: string) => void;
  onSelect: (item: Item) => void;
}): JSX.Element {
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-text">Your lists</h1>
        <NewListChip onEnter={onNewList} autoFocus={entries.length === 0} />
      </div>

      {error ? <p className="mb-4 text-[#DA3633]">{error}</p> : null}

      {entries.length === 0 ? (
        <p className="mt-8 text-muted">
          You don’t have any lists yet. Create one, then save titles with the + button on any movie
          or show.
        </p>
      ) : (
        entries.map((entry, i) => (
          <ListShelf
            key={entry.list.id}
            entry={entry}
            streamToken={streamToken}
            autoFocusFirst={i === 0}
            onOpen={() => onOpenList(entry.list.id)}
            onSelect={onSelect}
          />
        ))
      )}
    </div>
  );
}

/** One hub shelf: a focusable header ("Name · count", ENTER opens MORE), then
 *  the list's poster row capped by a "See all" card — or a hint when empty /
 *  still loading. */
function ListShelf({
  entry,
  streamToken,
  autoFocusFirst,
  onOpen,
  onSelect,
}: {
  entry: ListEntry;
  streamToken?: string;
  autoFocusFirst: boolean;
  onOpen: () => void;
  onSelect: (item: Item) => void;
}): JSX.Element {
  const { list, items, loading } = entry;
  // Hub shelves are capped — the MORE view shows everything.
  const shelf = items.slice(0, HUB_SHELF_CAP);
  return (
    <section className="mb-8">
      <ShelfHeader list={list} autoFocus={autoFocusFirst} onEnter={onOpen} />
      {loading ? (
        <p className="px-1 py-3 text-sm text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted">
          Save titles with the + button on any movie or show.
        </p>
      ) : (
        <div className="flex items-stretch gap-4 overflow-x-hidden py-3">
          {shelf.map((item) => (
            <FocusableCard
              key={item.id}
              item={item}
              streamToken={streamToken}
              onEnter={() => onSelect(item)}
            />
          ))}
          <SeeAllCard onEnter={onOpen} />
        </div>
      )}
    </section>
  );
}

/** Focusable shelf header — "Name · count". ENTER opens the list's MORE view. */
function ShelfHeader({
  list,
  autoFocus,
  onEnter,
}: {
  list: Watchlist;
  autoFocus?: boolean;
  onEnter: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={`inline-flex cursor-default select-none items-center gap-3 rounded-lg px-3 py-2 transition-colors ${
        focused ? 'bg-surface-2' : ''
      }`}
    >
      <h2 className="text-2xl font-semibold text-text">{list.name}</h2>
      {list.count != null ? <span className="text-lg text-muted">· {list.count}</span> : null}
      {list.is_default ? (
        <span className="text-xs uppercase tracking-wide text-muted">Default</span>
      ) : null}
    </div>
  );
}

/** Tile that mirrors a poster card's footprint and opens the MORE view. */
function SeeAllCard({ onEnter }: { onEnter: () => void }): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={`flex w-44 shrink-0 cursor-default select-none flex-col items-center justify-center rounded-lg bg-surface-2 transition-transform ${
        focused ? 'scale-105' : ''
      }`}
    >
      {/* Match the 2:3 poster aspect so the card lines up with its neighbours. */}
      <div className="flex aspect-[2/3] w-full flex-col items-center justify-center gap-2 text-accent">
        <ArrowLeft className="h-7 w-7 rotate-180" />
        <span className="text-lg font-medium">See all</span>
      </div>
    </div>
  );
}

/** The "New list" chip in the hub header. */
function NewListChip({
  onEnter,
  autoFocus,
}: {
  onEnter: () => void;
  autoFocus?: boolean;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={`inline-flex cursor-default select-none items-center gap-2 rounded-full border px-5 py-2.5 text-lg transition-colors ${
        focused ? 'border-accent bg-surface-2 text-accent' : 'border-border-2 bg-surface text-text'
      }`}
    >
      <Plus className="h-5 w-5" />
      New list
    </div>
  );
}

/* ──────────────────────────────  More  ──────────────────────────────────── */

function MoreView({
  entry,
  streamToken,
  onBack,
  onSelect,
  onRename,
  onDelete,
}: {
  entry: ListEntry;
  streamToken?: string;
  onBack: () => void;
  onSelect: (item: Item) => void;
  onRename: () => void;
  onDelete: () => void;
}): JSX.Element {
  const { list, items, loading } = entry;
  return (
    <div>
      {/* Header row: back · title · count · rename / delete actions. The default
          list can be renamed but never deleted (chino-api rejects it anyway). */}
      <div className="mb-6 flex items-center gap-4">
        <HeaderAction icon={<ArrowLeft className="h-5 w-5" />} label="Back" autoFocus onEnter={onBack} />
        <h1 className="text-3xl font-bold text-text">{list.name}</h1>
        {list.count != null ? <span className="text-xl text-muted">· {list.count}</span> : null}
        <div className="ml-auto flex items-center gap-3">
          <HeaderAction icon={<Pencil className="h-5 w-5" />} label="Rename" onEnter={onRename} />
          {!list.is_default ? (
            <HeaderAction
              icon={<Trash2 className="h-5 w-5" />}
              label="Delete"
              danger
              onEnter={onDelete}
            />
          ) : null}
        </div>
      </div>

      {loading ? (
        <Spinner label="Loading…" fullscreen={false} />
      ) : items.length === 0 ? (
        <p className="mt-8 text-muted">
          “{list.name}” is empty. Save titles with the + button on any movie or show.
        </p>
      ) : (
        // The MORE grid reuses MediaRow's card so progress/watched badges match
        // the rest of the shell; a wrapping flex track gives the full-grid feel
        // (the focus engine scrolls the focused card into view).
        <div className="flex flex-wrap gap-4 py-2">
          {items.map((item) => (
            <FocusableCard
              key={item.id}
              item={item}
              streamToken={streamToken}
              onEnter={() => onSelect(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A pill-shaped focusable header action (back / rename / delete). */
function HeaderAction({
  icon,
  label,
  danger,
  autoFocus,
  onEnter,
}: {
  icon: JSX.Element;
  label: string;
  danger?: boolean;
  autoFocus?: boolean;
  onEnter: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus });
  return (
    <div
      ref={ref}
      data-focused={focused}
      aria-label={label}
      className={`inline-flex cursor-default select-none items-center gap-2 rounded-full px-4 py-2 text-base transition-colors ${
        focused ? 'bg-surface-2' : 'bg-surface'
      } ${danger ? 'text-[#DA3633]' : 'text-text'}`}
    >
      {icon}
      <span>{label}</span>
    </div>
  );
}

// Hub shelves preview at most this many posters; the See-all / MORE view shows
// the full list. Mirrors the androidtv HUB_SHELF_CAP. (The hub shelf hand-rolls
// its card track rather than reusing <MediaRow> so it can append the See-all
// card to the end of the row — something the plain row primitive can't do.)
const HUB_SHELF_CAP = 12;
