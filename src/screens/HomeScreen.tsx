// Home — the landing surface after auth. Mirrors chino-androidtv's
// ui/library/LibraryScreen (LibraryContent) and chino-web's HomeSection:
//
//   ┌──────┬───────────────────────────────────────────────┐
//   │ Side │ TopBar (search · watchlist · account)          │
//   │ Rail ├───────────────────────────────────────────────┤
//   │      │ Hero banner (auto-rotating, pauses on focus)   │
//   │      │ Continue Watching · Next Up                    │
//   │      │ Recently added — Movies / Shows                │
//   │      │ Top Rated                                      │
//   │      │ By genre rails…                                │
//   └──────┴───────────────────────────────────────────────┘
//
// Data parity with both reference clients:
//   - hero pool = top-rated movies (rating>=7), fall back to recent movies;
//   - the slim /items list omits the description, so we fan out getItem(id)
//     detail fetches to fill each hero entry's overview (mirror androidtv);
//   - continue-watching is split into "Continue Watching" (in-progress) and
//     "Next Up" (server-substituted, up_next:true) shelves;
//   - "Recently added" rails request unwatched=true so finished titles drop
//     off the Home surface (Browse/Search leave it off for re-watch).
//
// D-pad interactivity is entirely the @/tv/focus engine — SideRail/TopBar and
// every card register their own focusables; the engine moves focus by geometry
// and scrolls the focused element into view, so the page just lays the rails
// out in a vertical stack. The hero's Play / More Info are focusables that pause
// the rotation while focused (a swap would destroy the focused node). BACK on
// Home exits the app (Home is the root destination, matching androidtv).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Info, Image as ImageIcon } from 'lucide-react';
import type { ContinueWatchingItem, Item } from '@/api/types';
import { api } from '@/api/instance';
import { useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { navigate } from '@/router';
import { SideRail } from '@/components/SideRail';
import { TopBar } from '@/components/TopBar';
import { MediaRow } from '@/components/MediaRow';
import { Spinner } from '@/components/Spinner';

// Home rails are capped at 20 (web/androidtv #150 parity) — no inline paging on
// Home; the full overview lives on the Browse screen.
const HOME_RAIL_SIZE = 20;
// Small hero pool so the pagination dots read cleanly; rotates every 12s like
// the androidtv tablet (web uses 20s; 12s matches the TV client).
const HERO_POOL_SIZE = 8;
const HERO_ROTATE_MS = 12_000;
// Number of genre rails to surface on Home. Kept small so the page doesn't
// become an endless scroll; each rail is a single unwatched=false query.
const GENRE_RAIL_COUNT = 3;
const GENRE_RAIL_SIZE = 20;

/** One labelled rail of catalogue items (used for the genre shelves). */
interface GenreRail {
  genre: string;
  items: Item[];
}

interface HomeData {
  streamToken: string;
  heroPool: Item[];
  /** Random start index so a refresh doesn't always foreground the same hero. */
  heroStart: number;
  continueWatching: ContinueWatchingItem[];
  recentMovies: Item[];
  recentSeries: Item[];
  topRated: Item[];
  genreRails: GenreRail[];
}

/**
 * The hero <img> URL: the backdrop, else the poster. chino-api hands both back
 * origin-relative ("/api/v1/items/{id}/backdrop"); the client resolves them on
 * the configured server and adds the stream token.
 */
function heroImageUrl(item: Item, streamToken: string): string {
  return item.backdrop_url ? api.backdropUrl(item, streamToken) : api.posterUrl(item, streamToken);
}

export default function HomeScreen(): JSX.Element {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Hero rotation index — independent of the data fetch so the carousel keeps
  // ticking without re-querying. Seeded from data.heroStart when data arrives.
  const [heroIndex, setHeroIndex] = useState(0);
  // Pause the carousel while the hero's Play / More Info holds focus, so a swap
  // never destroys the focused node (which would dump focus onto the rail).
  // Mirrors androidtv's heroRotationPaused + web pausing on hover/focus.
  const heroPausedRef = useRef(false);

  // BACK on Home = exit the app. Home is the root destination (androidtv pops
  // the whole back stack here); there's nowhere to go back to. Guarded so it's
  // a no-op off-device (browser dev).
  useRemoteKey(TVKey.BACK, () => {
    try {
      window.tizen?.application?.getCurrentApplication().exit();
    } catch {
      /* off-device / browser dev — nothing to exit */
    }
  });

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        // Fan out every Home query in parallel so the slowest single call gates
        // first paint, not the sum. Each rail is best-effort: a failed shelf
        // resolves to [] rather than blanking the whole page (chino-api can
        // return an empty body for an empty table).
        const [
          streamToken,
          recentMovies,
          recentSeries,
          topRated,
          continueWatching,
          heroPoolRaw,
        ] = await Promise.all([
          api.streamToken().catch(() => ''),
          api
            .listItems({ type: 'movie', sort: 'newest', unwatched: true, limit: HOME_RAIL_SIZE })
            .then((r) => r.items)
            .catch(() => [] as Item[]),
          api
            .listItems({ type: 'series', sort: 'newest', unwatched: true, limit: HOME_RAIL_SIZE })
            .then((r) => r.items)
            .catch(() => [] as Item[]),
          api
            .listItems({
              type: 'movie',
              sort: 'rating',
              rating_min: 8,
              unwatched: true,
              limit: HOME_RAIL_SIZE,
            })
            .then((r) => r.items)
            .catch(() => [] as Item[]),
          api.continueWatching().catch(() => [] as ContinueWatchingItem[]),
          // Hero pool: top-rated movies (rating>=7) so the carousel always
          // foregrounds something good. Fall back below to recent items.
          api
            .listItems({
              type: 'movie',
              sort: 'rating',
              rating_min: 7,
              unwatched: true,
              limit: HERO_POOL_SIZE,
            })
            .then((r) => r.items)
            .catch(() => [] as Item[]),
        ]);
        if (cancelled) return;

        // Hero pool falls back to the recent movies/series when the rating
        // query came back empty (small or freshly-scanned library).
        const rawPool =
          heroPoolRaw.length > 0
            ? heroPoolRaw
            : [...recentMovies, ...recentSeries].slice(0, 1);

        // The slim list endpoint omits the description, so the hero overview
        // would render blank. Fan out parallel getItem(id) detail fetches and
        // copy each item's description back onto the hero entry (mirror
        // androidtv); keep the original on failure.
        const heroPool = await Promise.all(
          rawPool.map((it) =>
            api
              .getItem(it.id)
              .then((detail) => ({ ...it, description: detail.description ?? it.description }))
              .catch(() => it),
          ),
        );
        if (cancelled) return;

        // A few genre rails off the recent catalogue's genres — gives the Home
        // page some breadth without an endless scroll. Genres are gathered from
        // the items we already fetched (no genre endpoint dependency); each rail
        // is a single best-effort query.
        const genrePool = new Set<string>();
        for (const it of [...recentMovies, ...recentSeries, ...topRated]) {
          for (const g of it.genres ?? []) genrePool.add(g);
        }
        const chosenGenres = Array.from(genrePool).slice(0, GENRE_RAIL_COUNT);
        const genreRails = (
          await Promise.all(
            chosenGenres.map((genre) =>
              api
                .listItems({ genre, sort: 'rating', limit: GENRE_RAIL_SIZE })
                .then((r): GenreRail => ({ genre, items: r.items }))
                .catch((): GenreRail => ({ genre, items: [] })),
            ),
          )
        ).filter((rail) => rail.items.length > 0);
        if (cancelled) return;

        const heroStart =
          heroPool.length >= 2 ? Math.floor(Math.random() * heroPool.length) : 0;

        setData({
          streamToken,
          heroPool,
          heroStart,
          continueWatching,
          recentMovies,
          recentSeries,
          topRated,
          genreRails,
        });
        setHeroIndex(heroStart);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load library');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hero rotation ticker — advances heroIndex every HERO_ROTATE_MS unless the
  // hero buttons hold focus (heroPausedRef). Kept independent of the data fetch.
  const poolSize = data?.heroPool.length ?? 0;
  useEffect(() => {
    if (poolSize < 2) return;
    const id = window.setInterval(() => {
      if (heroPausedRef.current) return;
      setHeroIndex((i) => (i + 1) % poolSize);
    }, HERO_ROTATE_MS);
    return () => window.clearInterval(id);
  }, [poolSize]);

  const onSelect = useCallback((item: Item) => {
    navigate(`/detail/${item.id}`);
  }, []);

  // Split the continue-watching feed into in-progress (Continue Watching) and
  // server-substituted (Next Up) shelves — mirrors web/androidtv.
  const { cwRows, nextUpRows } = useMemo(() => {
    const cw = data?.continueWatching ?? [];
    return {
      cwRows: cw.filter((it) => !it.up_next),
      nextUpRows: cw.filter((it) => it.up_next),
    };
  }, [data?.continueWatching]);

  if (error) {
    return (
      <div className="flex min-h-screen bg-bg text-text">
        <SideRail active="home" />
        <div className="flex flex-1 flex-col">
          <TopBar />
          <div className="flex flex-1 items-center justify-center p-12 text-center text-muted">
            Couldn’t load your library. {error}
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-screen bg-bg text-text">
        <SideRail active="home" />
        <div className="flex flex-1 flex-col">
          <TopBar />
          <Spinner label="Loading library…" />
        </div>
      </div>
    );
  }

  const hero = data.heroPool[heroIndex] ?? data.heroPool[0];

  return (
    <div className="flex min-h-screen bg-bg text-text">
      <SideRail active="home" />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {/* The whole content column scrolls; the focus engine's scrollIntoView
            walks DOWN past the visible region. The rail + TopBar stay fixed. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-12 pt-6">
          {hero ? (
            <Hero
              item={hero}
              streamToken={data.streamToken}
              index={heroIndex}
              count={data.heroPool.length}
              onPlay={() => navigate(`/player/${hero.id}`)}
              onMoreInfo={() => navigate(`/detail/${hero.id}`)}
              onFocusWithin={(focused) => {
                heroPausedRef.current = focused;
              }}
            />
          ) : null}

          {cwRows.length > 0 ? (
            <MediaRow
              title="Continue Watching"
              items={cwRows}
              streamToken={data.streamToken}
              onSelect={onSelect}
            />
          ) : null}

          {nextUpRows.length > 0 ? (
            <MediaRow
              title="Next Up"
              items={nextUpRows}
              streamToken={data.streamToken}
              onSelect={onSelect}
            />
          ) : null}

          {data.recentMovies.length > 0 ? (
            <MediaRow
              title="Recently added — Movies"
              items={data.recentMovies}
              streamToken={data.streamToken}
              onSelect={onSelect}
            />
          ) : null}

          {data.recentSeries.length > 0 ? (
            <MediaRow
              title="Recently added — Shows"
              items={data.recentSeries}
              streamToken={data.streamToken}
              onSelect={onSelect}
            />
          ) : null}

          {data.topRated.length > 0 ? (
            <MediaRow
              title="Top Rated"
              items={data.topRated}
              streamToken={data.streamToken}
              onSelect={onSelect}
            />
          ) : null}

          {data.genreRails.map((rail) => (
            <MediaRow
              key={rail.genre}
              title={rail.genre}
              items={rail.items}
              streamToken={data.streamToken}
              onSelect={onSelect}
            />
          ))}

          {/* Library-empty fallback — both core rails came back empty. */}
          {data.recentMovies.length === 0 &&
          data.recentSeries.length === 0 &&
          cwRows.length === 0 &&
          nextUpRows.length === 0 ? (
            <div className="flex items-center justify-center p-16 text-center text-muted">
              Your library is empty. Add titles on your server to see them here.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────  Hero banner  ──────────────────────────── */

interface HeroProps {
  item: Item;
  streamToken: string;
  index: number;
  count: number;
  onPlay: () => void;
  onMoreInfo: () => void;
  /** Fired true while either hero button holds focus (pauses rotation). */
  onFocusWithin: (focused: boolean) => void;
}

/**
 * Hero banner — backdrop anchored right with a left-to-transparent gradient over
 * the image (the chino-web / androidtv HeroSection layout), title + meta + a
 * 3-line overview top-left, and the Play / More Info buttons bottom-left. Both
 * buttons are focus engine focusables; while either holds focus the carousel is
 * paused via onFocusWithin so a rotation never swaps the focused node away.
 */
function Hero({
  item,
  streamToken,
  index,
  count,
  onPlay,
  onMoreInfo,
  onFocusWithin,
}: HeroProps): JSX.Element {
  // Each button reports focus; the banner is "focused-within" if either is.
  const play = useFocusable({
    onEnter: onPlay,
    autoFocus: true,
    onFocus: () => onFocusWithin(true),
  });
  const moreInfo = useFocusable({
    onEnter: onMoreInfo,
    onFocus: () => onFocusWithin(true),
  });

  // The focus engine only fires onFocus on gain; clear the pause when neither
  // button is focused (i.e. focus stepped down to a shelf). We watch both
  // `focused` flags and resume rotation when both are false.
  useEffect(() => {
    if (!play.focused && !moreInfo.focused) onFocusWithin(false);
  }, [play.focused, moreInfo.focused, onFocusWithin]);

  const image = heroImageUrl(item, streamToken);
  const ratingLabel = item.rating != null ? item.rating.toFixed(1) : undefined;

  return (
    <div className="relative mb-8 h-[28rem] w-full overflow-hidden rounded-xl bg-black">
      {/* Backdrop — anchored to the right 60%, cropped; gradient masks the left. */}
      {image ? (
        <img
          src={image}
          alt=""
          aria-hidden
          className="absolute right-0 top-0 h-full w-[60%] object-cover"
        />
      ) : (
        <div className="absolute right-0 top-0 flex h-full w-[60%] items-center justify-center text-border-2">
          <ImageIcon className="h-12 w-12" />
        </div>
      )}
      {/* Left black-to-transparent mask: opaque for the text inset, fading by
          ~64% (matches web's mask-image: linear-gradient(to left, …)). */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to right, #000 0%, #000 40%, rgba(0,0,0,0) 64%, rgba(0,0,0,0) 100%)',
        }}
      />

      {/* Title + meta + overview — top-left. */}
      <div className="absolute left-12 top-12 max-w-[30rem]">
        <h1 className="text-5xl font-extrabold leading-tight text-white line-clamp-2">
          {item.title}
        </h1>
        <div className="mt-3 flex items-center gap-3 text-lg text-white">
          {item.year ? <span>{item.year}</span> : null}
          {ratingLabel ? (
            <span className="rounded bg-accent px-2 py-0.5 text-sm font-semibold text-white">
              {ratingLabel}
            </span>
          ) : null}
        </div>
        {item.description ? (
          <p className="mt-4 text-lg leading-relaxed text-text line-clamp-3">
            {item.description}
          </p>
        ) : null}
      </div>

      {/* Play + More Info — bottom-left, above the pagination dots. */}
      <div className="absolute bottom-16 left-12 flex items-center gap-4">
        <button
          ref={play.ref}
          type="button"
          data-focused={play.focused}
          className={`flex items-center gap-2 rounded-lg px-6 py-3 text-lg font-semibold text-white outline-none transition-colors ${
            play.focused ? 'bg-accent' : 'bg-accent'
          }`}
        >
          <Play className="h-5 w-5" />
          Play
        </button>
        <button
          ref={moreInfo.ref}
          type="button"
          data-focused={moreInfo.focused}
          className={`flex items-center gap-2 rounded-lg px-6 py-3 text-lg font-semibold text-white outline-none transition-colors ${
            moreInfo.focused ? 'bg-white/30' : 'bg-white/20'
          }`}
        >
          <Info className="h-5 w-5" />
          More Info
        </button>
      </div>

      {/* Pagination dots — bottom-left, below the buttons. Non-interactive. */}
      {count > 1 ? (
        <div className="absolute bottom-6 left-12 flex items-center gap-1.5">
          {Array.from({ length: count }).map((_, i) => (
            <span
              key={i}
              className={`h-2 w-2 rounded-full ${
                i === index ? 'bg-white' : 'bg-white/30'
              }`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
