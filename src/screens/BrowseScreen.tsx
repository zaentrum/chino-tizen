// Browse / library grid for the Tizen TV shell. Rail + top-bar chrome (parity
// with Search / Watchlist) wrapping a content column whose head carries a
// "Movies" / "Series" heading plus the filter affordances, and whose body is a
// wrapping poster grid the focus engine walks geometrically.
//
// The content type comes from the route (`/browse/:type`, type = movie | series)
// — useRoute().params.type, defaulting to 'movie' — so the rail's Movies vs
// Series cell lights up via SideRail activeType. The screen mirrors chino-web's
// MoviesSection / SeriesSection and chino-androidtv's LibraryScreen: a Genre
// chip row + a Sort chip row above an auto-fill poster grid, infinite-scroll
// paging, no dropdowns anywhere (a hard design rule across the clients — every
// selectable axis is a horizontal, D-pad-focusable chip row).
//
// IMPORTANT design rules honoured here:
//   - NO dropdowns. Genre and Sort are chip ROWS (chino-web's BrowseFilters /
//     androidtv's FilterChipsRow shape), so a 10-foot D-pad can land on them.
//   - Genre chips are the catalogue's genres (GET /genres, as chino-web's
//     BrowseFilters loads them — list rows carry no genres to derive them
//     from), with an "All" chip that clears the filter, and a short fixed set
//     while /genres is not in or unavailable.
//   - Sort options match the cross-client set, mapped to the chino-api `sort`
//     values chino-web's BrowseQuery uses: Recommended → rating, Newest →
//     newest, A–Z → title.
//
// Paging: api.listItems returns at most `limit` rows (the BFF derives no real
// total), so "the last page filled the window" (page.length === LIMIT) is the
// signal there may be more. A trailing "Load more" focusable pulls the next
// page; reaching it via D-pad focus also kicks the load so scrolling feels
// continuous (the focus engine's geometric walk has no IntersectionObserver, so
// the card/footer onFocus is the TV-native equivalent of web's sentinel).
// Changing any chip resets the offset and reloads from the top.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Item } from '@/api/types';
import { api } from '@/api/instance';
import SideRail from '@/components/SideRail';
import TopBar from '@/components/TopBar';
import FocusableCard from '@/components/FocusableCard';
import Spinner from '@/components/Spinner';
import { useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { navigate, back, useRoute } from '@/router';

// One page of cards. Matches the SearchScreen / chino-web PAGE_SIZE band — big
// enough to fill the grid above the fold, small enough that the first paint is
// quick on a TV's modest CPU.
const LIMIT = 60;

// The chino-api `sort` keys (chino-web's BrowseQuery sort union). The label is
// what the user sees; `key` is what goes on the wire. Default is Recommended.
interface SortOption {
  label: string;
  key: string;
}
const SORTS: SortOption[] = [
  { label: 'Recommended', key: 'rating' },
  { label: 'Newest', key: 'newest' },
  { label: 'A–Z', key: 'title' },
];
const DEFAULT_SORT = SORTS[0].key;

// Fallback genre chips while the catalogue's genres (GET /genres) are not in,
// or when that call fails. Kept short and neutral.
const FALLBACK_GENRES = [
  'Action',
  'Comedy',
  'Drama',
  'Sci-Fi',
  'Thriller',
  'Documentary',
];

/** Heading + the sub-line genre noun for the active content type. */
function typeLabels(type: string): { heading: string; noun: string } {
  return type === 'series'
    ? { heading: 'Series', noun: 'shows' }
    : { heading: 'Movies', noun: 'movies' };
}

export default function BrowseScreen(): JSX.Element {
  const { params } = useRoute();
  // The route param is the source of truth; default to movies when absent.
  const type = params.type === 'series' ? 'series' : 'movie';
  const { heading, noun } = typeLabels(type);

  // Active filters. `sort` defaults to Recommended; `genre` undefined === "All".
  const [sort, setSort] = useState<string>(DEFAULT_SORT);
  const [genre, setGenre] = useState<string | undefined>(undefined);

  // Accumulated grid + paging state. `offset` is the next page's offset; `more`
  // is true while the last page came back full (so another may exist).
  const [items, setItems] = useState<Item[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(true);
  // 'loading' is the first-page fetch (full-screen Spinner); 'paging' is an
  // append (inline footer spinner); 'ready' otherwise. Errors carry a message.
  const [status, setStatus] = useState<'loading' | 'paging' | 'ready' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);

  // Best-effort stream token for poster artwork (artwork lives in chino-api's
  // stream-token group). Minted once on mount; posters degrade to the card
  // placeholder if it never arrives.
  const [streamToken, setStreamToken] = useState<string | undefined>(undefined);

  // The genre chips: the catalogue's genres (GET /genres, chino-web's
  // source) — list rows carry no genres to derive them from.
  const [genres, setGenres] = useState<string[]>(FALLBACK_GENRES);
  useEffect(() => {
    let alive = true;
    void api
      .genres()
      .then((list) => {
        if (alive && list.length > 0) setGenres(list);
      })
      .catch(() => {
        /* keep the fallback chips */
      });
    return () => {
      alive = false;
    };
  }, []);

  // A monotonically increasing token so a slow earlier request can never clobber
  // a newer result after the user changes a chip (the latest run always wins).
  const runRef = useRef(0);
  // Guard so a single focus-driven prefetch can't fire repeatedly while the
  // page is in flight.
  const loadingMoreRef = useRef(false);

  useRemoteKey(TVKey.BACK, () => back());

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

  // Fetch one page. `reset` true replaces the grid (first load / chip change);
  // false appends (paging). The run token discards stale responses.
  const loadPage = useCallback(
    async (nextOffset: number, reset: boolean) => {
      const run = ++runRef.current;
      if (reset) {
        setStatus('loading');
        setError(null);
      } else {
        setStatus('paging');
      }
      loadingMoreRef.current = true;
      try {
        const page = await api.listItems({
          type,
          sort,
          genre,
          limit: LIMIT,
          offset: nextOffset,
        });
        if (run !== runRef.current) return; // superseded by a newer run
        setItems((prev) => (reset ? page.items : [...prev, ...page.items]));
        setOffset(nextOffset + page.items.length);
        // A full page means there may be more; a short page is the end.
        setMore(page.items.length >= LIMIT);
        setStatus('ready');
      } catch (e: unknown) {
        if (run !== runRef.current) return;
        setError(e instanceof Error ? e.message : 'Failed to load the library.');
        setStatus('error');
      } finally {
        if (run === runRef.current) loadingMoreRef.current = false;
      }
    },
    [type, sort, genre],
  );

  // (Re)load from the top whenever the type or a filter chip changes.
  useEffect(() => {
    void loadPage(0, true);
  }, [loadPage]);

  // Append the next page — guarded so card/footer focus can't double-fire it.
  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || !more || status === 'loading') return;
    void loadPage(offset, false);
  }, [loadPage, offset, more, status]);

  const onSelectSort = (key: string): void => {
    if (key === sort) return;
    setSort(key);
  };

  const onSelectGenre = (g: string | undefined): void => {
    if (g === genre) return;
    setGenre(g);
  };

  // Index from which a card's onFocus should prefetch the next page — focusing
  // anything in the final row band kicks the load before the user hits bottom.
  const prefetchFrom = Math.max(0, items.length - LIMIT / 3);

  return (
    <div className="flex h-screen w-full bg-bg text-text">
      <SideRail active="browse" activeType={type} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 overflow-y-auto px-10 py-6">
          <h1 className="mb-6 text-4xl font-bold text-text">{heading}</h1>

          {/* Filter affordances — chip ROWS only, never dropdowns. Genre first
              (derived from the catalogue), then Sort. */}
          <FilterRows
            genres={genres}
            genre={genre}
            sort={sort}
            onSelectGenre={onSelectGenre}
            onSelectSort={onSelectSort}
          />

          {status === 'loading' ? (
            <Spinner label={`Loading ${noun}…`} fullscreen={false} />
          ) : status === 'error' ? (
            <BrowseMessage
              headline="Couldn’t load the library"
              hint={error ?? undefined}
              isError
            />
          ) : items.length === 0 ? (
            <BrowseMessage
              headline={`No ${noun} to show`}
              hint={
                genre
                  ? `Nothing tagged “${genre}”. Pick “All” to clear the filter.`
                  : 'This library is empty.'
              }
            />
          ) : (
            <>
              {/* Wrapping poster grid: fixed-width tiles (FocusableCard owns the
                  2:3 footprint) so the engine's geometric walk stays in clean
                  rows/columns. gap + py give the focused card's scale room. */}
              <div className="flex flex-wrap gap-4 py-2">
                {items.map((item, i) => (
                  <FocusableCard
                    key={item.id}
                    item={item}
                    streamToken={streamToken}
                    // Land focus on the first card after a fresh load so DOWN
                    // from the chip rows / a screen entry has somewhere to go.
                    autoFocus={i === 0}
                    // Focusing a card near the end pulls the next page — the
                    // TV-native equivalent of web's IntersectionObserver
                    // sentinel (the focus engine does no scroll observation).
                    onFocus={i >= prefetchFrom ? loadMore : undefined}
                    onEnter={() => navigate(`/detail/${item.id}`)}
                  />
                ))}
              </div>

              {/* Trailing affordance: a focusable "Load more" while pages
                  remain (also pulls on focus), or an end-of-catalogue line. */}
              {more ? (
                <LoadMore
                  paging={status === 'paging'}
                  onEnter={loadMore}
                  onFocus={loadMore}
                />
              ) : (
                <p className="mt-8 text-center text-sm text-muted">
                  You’ve reached the end — {items.length} {noun}.
                </p>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/* ────────────────────────────  Filter chip rows  ───────────────────────────── */

interface FilterRowsProps {
  genres: string[];
  genre: string | undefined;
  sort: string;
  onSelectGenre: (g: string | undefined) => void;
  onSelectSort: (key: string) => void;
}

/** Genre row (All + derived genres) above the Sort row. Both are horizontal,
 *  D-pad-focusable chip strips — the no-dropdown contract. */
function FilterRows({
  genres,
  genre,
  sort,
  onSelectGenre,
  onSelectSort,
}: FilterRowsProps): JSX.Element {
  return (
    <div className="mb-8 space-y-3">
      <div className="flex items-center gap-3">
        <span className="w-16 shrink-0 text-sm text-muted">Genre</span>
        <div className="flex flex-wrap gap-2">
          <Chip
            label="All"
            active={genre == null}
            onEnter={() => onSelectGenre(undefined)}
          />
          {genres.map((g) => (
            <Chip
              key={g}
              label={g}
              active={genre === g}
              // Re-selecting the active genre clears it (back to "All"), matching
              // the toggle behaviour of the reference chip rows.
              onEnter={() => onSelectGenre(genre === g ? undefined : g)}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-16 shrink-0 text-sm text-muted">Sort</span>
        <div className="flex flex-wrap gap-2">
          {SORTS.map((s) => (
            <Chip
              key={s.key}
              label={s.label}
              active={sort === s.key}
              onEnter={() => onSelectSort(s.key)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A single focusable filter chip. Active = accent fill; focus adds the ring
 *  (data-focused) + a subtle surface lift. Mirrors chino-web's Chip and the
 *  androidtv FilterChip. */
function Chip({
  label,
  active,
  onEnter,
}: {
  label: string;
  active: boolean;
  onEnter: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter });
  return (
    <div
      ref={ref}
      data-focused={focused}
      aria-pressed={active}
      className={`cursor-default select-none rounded-full border px-4 py-1.5 text-sm transition-colors ${
        active
          ? 'border-accent bg-accent text-bg'
          : focused
            ? 'border-accent bg-surface-2 text-text'
            : 'border-border-2 bg-surface text-text'
      }`}
    >
      {label}
    </div>
  );
}

/* ────────────────────────────  Paging footer  ──────────────────────────────── */

/** Trailing focusable that pulls the next page on ENTER or on focus, showing a
 *  spinner glyph while a page is in flight. */
function LoadMore({
  paging,
  onEnter,
  onFocus,
}: {
  paging: boolean;
  onEnter: () => void;
  onFocus: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, onFocus });
  return (
    <div className="mt-8 flex justify-center">
      <div
        ref={ref}
        data-focused={focused}
        className={`inline-flex cursor-default select-none items-center gap-2 rounded-full border px-6 py-2.5 text-base transition-colors ${
          focused ? 'border-accent bg-surface-2 text-accent' : 'border-border-2 bg-surface text-text'
        }`}
      >
        {paging ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : null}
        <span>{paging ? 'Loading…' : 'Load more'}</span>
      </div>
    </div>
  );
}

/* ────────────────────────────  Empty / error  ──────────────────────────────── */

/** Centred headline + optional hint for the empty / error states. */
function BrowseMessage({
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
      <p className={`text-2xl font-semibold ${isError ? 'text-red' : 'text-text'}`}>
        {headline}
      </p>
      {hint ? <p className="text-muted">{hint}</p> : null}
    </div>
  );
}
