// Search surface for the Tizen TV shell. Rail + top-bar chrome (parity with
// Browse / Watchlist) with the LIVE search field hosted in-line below the top
// bar: activating it opens the on-screen QWERTY (@/components/KeyboardOverlay),
// and every edit re-runs a debounced search. Results are a "Cast & crew" people
// row (api.searchPeople) above a merged title grid (movies + series, server
// relevance order — no client re-rank), exactly like chino-androidtv
// ui/search/SearchScreen.kt + SearchViewModel.kt and chino-web's single results
// grid. DOWN from the search field lands on the first focusable result (first
// person chip when there are people, else the first title card) via autoFocus.
//
// Data fan-out mirrors SearchViewModel: movies + series + people in parallel;
// people are best-effort (an older server without /people just leaves the row
// empty rather than failing the whole search). The 250ms debounce matches the
// reference VM so we don't hammer chino-api on every keystroke.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search as SearchIcon, User as UserIcon } from 'lucide-react';
import type { Item, Person } from '@/api/types';
import { api } from '@/api/instance';
import SideRail from '@/components/SideRail';
import TopBar from '@/components/TopBar';
import FocusableCard from '@/components/FocusableCard';
import Spinner from '@/components/Spinner';
import KeyboardOverlay from '@/components/KeyboardOverlay';
import { useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { navigate, back } from '@/router';

// Page size for the title fan-out (movies + series each). Matches the
// SearchViewModel PAGE_SIZE — enough to fill the grid without paging.
const PAGE_SIZE = 60;
// Cap the people row: it sits above the title grid, so a long list would push
// the titles below the fold. Matches SearchViewModel.PEOPLE_LIMIT.
const PEOPLE_LIMIT = 12;
// Debounce window for live search — same as the reference VM / mobile screen.
const DEBOUNCE_MS = 250;

type SearchState =
  | { kind: 'empty' }
  | { kind: 'searching' }
  | { kind: 'nomatches' }
  | { kind: 'error'; message: string }
  | { kind: 'results'; items: Item[]; people: Person[] };

export default function SearchScreen(): JSX.Element {
  // Seed the query from ?q= so a deep-link / a navigate('/search?q=…') lands on
  // a pre-run search (the router strips the query, but it stays in the URL).
  const [query, setQuery] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('q') ?? '';
    } catch {
      return '';
    }
  });
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState<SearchState>({ kind: 'empty' });
  // A stream token authorises the poster <img> URLs (artwork lives in the
  // stream-token group). Best-effort: minted once on mount, posters just render
  // their placeholder if it never arrives.
  const [streamToken, setStreamToken] = useState<string | undefined>(undefined);

  // BACK: close the keyboard if it's open, otherwise pop the route.
  useRemoteKey(TVKey.BACK, () => {
    if (editing) {
      setEditing(false);
      return;
    }
    back();
  });

  useEffect(() => {
    let alive = true;
    void api
      .streamToken()
      .then((t) => {
        if (alive) setStreamToken(t);
      })
      .catch(() => {
        /* artwork falls back to the unauthorised placeholder */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Debounced live search. A per-keystroke timer is reset on every change; the
  // latest run wins via a monotonically increasing token so a slow earlier
  // request can't clobber a newer result.
  const runRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (trimmed === '') {
      setState({ kind: 'empty' });
      return;
    }
    setState({ kind: 'searching' });
    const run = ++runRef.current;
    // Fan out movies + series + people in parallel. Movies+series merge into
    // one grid (movies first) — the reference clients render a single results
    // grid rather than per-type shelves. People feed the "Cast & crew" row and
    // are best-effort (404 on an older server → empty row, not a failed search).
    Promise.all([
      api.listItems({ q: trimmed, type: 'movie', limit: PAGE_SIZE }).then((r) => r.items),
      api.listItems({ q: trimmed, type: 'series', limit: PAGE_SIZE }).then((r) => r.items),
      api.searchPeople(trimmed, PEOPLE_LIMIT).catch(() => [] as Person[]),
    ])
      .then(([movies, series, people]) => {
        if (run !== runRef.current) return; // a newer search superseded this one
        const items = [...movies, ...series];
        if (items.length === 0 && people.length === 0) {
          setState({ kind: 'nomatches' });
        } else {
          setState({ kind: 'results', items, people });
        }
      })
      .catch((e: unknown) => {
        if (run !== runRef.current) return;
        setState({ kind: 'error', message: e instanceof Error ? e.message : 'Search failed' });
      });
  }, []);

  const onQueryChange = useCallback(
    (next: string) => {
      setQuery(next);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => runSearch(next), DEBOUNCE_MS);
    },
    [runSearch],
  );

  // Run the seeded ?q= search once on mount.
  useEffect(() => {
    if (query.trim() !== '') runSearch(query);
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-screen w-full bg-bg text-text">
      <SideRail active="search" />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex-1 overflow-y-auto px-10 py-6">
          {/* In-line live search field: activating opens the QWERTY overlay. */}
          <SearchField value={query} onEnter={() => setEditing(true)} />

          <div className="mt-8">
            {state.kind === 'empty' ? (
              <SearchMessage
                headline="Search the library"
                hint="Open the keyboard to look up a movie or show title."
              />
            ) : null}
            {state.kind === 'searching' ? <Spinner label={`Searching for “${query}”…`} fullscreen={false} /> : null}
            {state.kind === 'nomatches' ? (
              <SearchMessage headline={`No results for “${query}”`} />
            ) : null}
            {state.kind === 'error' ? (
              <SearchMessage headline="Search failed" hint={state.message} isError />
            ) : null}
            {state.kind === 'results' ? (
              <Results query={query} items={state.items} people={state.people} streamToken={streamToken} />
            ) : null}
          </div>
        </div>
      </div>

      {editing ? (
        <KeyboardOverlay
          value={query}
          onChange={onQueryChange}
          // "Done" closes the keyboard; focus then settles on the first result
          // (autoFocus on the first card/chip), which is the "done typing →
          // browse" handoff the androidtv IME search action performs.
          onSubmit={() => setEditing(false)}
          onClose={() => setEditing(false)}
          title="Search"
          placeholder="Search movies, shows…"
        />
      ) : null}
    </div>
  );
}

/** Read-only display of the live query; activating it opens the keyboard. The
 *  leading magnifier + placeholder mirror the top-bar / mobile / web search. */
function SearchField({ value, onEnter }: { value: string; onEnter: () => void }): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus: value.trim() === '' });
  return (
    <button
      ref={ref}
      type="button"
      data-focused={focused}
      className={`flex h-12 w-full max-w-2xl items-center gap-3 rounded-lg border bg-surface px-4 text-left outline-none transition-colors ${
        focused ? 'border-accent' : 'border-border-2'
      }`}
    >
      <SearchIcon className="h-5 w-5 shrink-0 text-text" />
      {value ? (
        <span className="truncate text-text">{value}</span>
      ) : (
        <span className="truncate text-muted">Search movies, shows…</span>
      )}
    </button>
  );
}

interface ResultsProps {
  query: string;
  items: Item[];
  people: Person[];
  streamToken?: string;
}

/**
 * Results view: the "Cast & crew" people row (when any matched) above the merged
 * title grid. The first focusable below the search field gets autoFocus so DOWN
 * from the input lands there: the first person chip when there are people, else
 * the first title card.
 */
function Results({ query, items, people, streamToken }: ResultsProps): JSX.Element {
  const hasPeople = people.length > 0;
  const countLabel =
    items.length === 1 ? `1 result for “${query}”` : `${items.length} results for “${query}”`;

  return (
    <div className="flex flex-col gap-8">
      {hasPeople ? (
        <section>
          <h2 className="mb-4 text-2xl font-semibold text-text">Cast &amp; crew</h2>
          <div className="flex gap-4 overflow-x-hidden py-2">
            {people.map((person, i) => (
              <PersonChip
                key={person.id}
                person={person}
                autoFocus={i === 0}
                onEnter={() => navigate(`/person/${person.id}`)}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="mb-4 text-2xl font-semibold text-text">{countLabel}</h2>
        {items.length === 0 ? (
          <p className="text-muted">No matching titles.</p>
        ) : (
          // Grid wraps to fill the content area; the focus engine handles
          // up/down/left/right between cards geometrically. gap + py give the
          // focused card's scale-105 room to grow without clipping.
          <div className="flex flex-wrap gap-4 py-2">
            {items.map((item, i) => (
              <FocusableCard
                key={item.id}
                item={item}
                streamToken={streamToken}
                // First title card takes the DOWN-from-input focus only when no
                // people row sits above it to receive it first.
                autoFocus={!hasPeople && i === 0}
                onEnter={() => navigate(`/detail/${item.id}`)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * One focusable "Cast & crew" person chip: an initials-avatar placeholder (no
 * person photos exist), the name, and "· N titles". ENTER opens the Person
 * surface. Fixed width so D-pad focus across the row stays sane. Mirrors the
 * androidtv PersonChip.
 */
function PersonChip({
  person,
  onEnter,
  autoFocus,
}: {
  person: Person;
  onEnter: () => void;
  autoFocus?: boolean;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus });
  const credits = person.credits ?? 0;
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={`flex w-64 shrink-0 cursor-default select-none items-center gap-3 rounded-lg border px-3 py-3 transition-colors ${
        focused ? 'border-accent bg-surface-2' : 'border-border-2 bg-surface'
      }`}
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-bg text-text">
        {initialsOf(person.name) || <UserIcon className="h-5 w-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-text">{person.name}</div>
        <div className="truncate text-sm text-muted">· {creditLabel(credits)}</div>
      </div>
    </div>
  );
}

/** Up to two initials from a person's name, e.g. "Greta Gerwig" -> "GG". Shared
 *  shape with PersonScreen. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0]?.[0]?.toUpperCase() ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0]?.toUpperCase() ?? '' : '';
  return first + last;
}

/** "· N titles" copy, singularising at 1. Matches the Person header label. */
function creditLabel(credits: number): string {
  return credits === 1 ? '1 title' : `${credits} titles`;
}

/** Centred headline + optional hint for empty / no-match / error states. */
function SearchMessage({
  headline,
  hint,
  isError,
}: {
  headline: string;
  hint?: string;
  isError?: boolean;
}): JSX.Element {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
      <p className={`text-2xl font-semibold ${isError ? 'text-red' : 'text-text'}`}>{headline}</p>
      {hint ? <p className="text-muted">{hint}</p> : null}
    </div>
  );
}
