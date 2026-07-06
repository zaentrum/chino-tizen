// Movie / show detail surface for the Tizen TV shell.
//
// Layout authority: chino-androidtv ui/detail/DetailScreen.kt (the 10-foot
// composition — backdrop hero, poster + metadata overlapping it, an action row
// of Play/Resume + Start-over + Trailer + watchlist/watched circles, a focusable
// cast & crew shelf, a seasons accordion of episode rows for series, and a
// "More like this" rail). Data authority: chino-web's DetailPage + its
// useItem / useSeriesEpisodes / useSimilarItems hooks and chino-api's router.
//
// Content order matches both references: title → tagline → meta → genres →
// actions → description → footer (subtitles / analyzed) → cast → episodes →
// similar. Everything interactive is a @/tv/focus focusable so the D-pad walks
// the whole page; BACK pops the route.
//
// Three endpoints this screen needs are not surfaced on the shared ChinoClient
// (series episodes, next-episode, saved progress) — exactly as chino-web reads
// them straight from fetch in its hooks and androidtv reads them off ChinoApi.
// We mirror that here with a small authorised-fetch helper bound to the
// configured server + active session token (authStore). See `assumptions`.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Image as ImageIcon,
  Play,
  Plus,
  Star,
  Youtube,
} from 'lucide-react';
import type { CastEntry, Item } from '@/api/types';
import { api } from '@/api/instance';
import { authStore } from '@/auth/session';
import { useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { navigate, back } from '@/router';
import { Spinner } from '@/components/Spinner';

/* ───────────────────────────  episode wire types  ──────────────────────────
 * Shapes match chino-api's GET /v1/series/{id}/episodes (web useSeriesEpisodes /
 * androidtv SeriesEpisodes): snake_case episode rows grouped into seasons. */

interface EpisodeRowData {
  id: string;
  title: string;
  season_number?: number;
  episode_number?: number;
  parent_id?: string;
  /** RFC3339 timestamp, or null/absent when the user hasn't finished it. */
  watched_at?: string | null;
  /** katalog emits the episode synopsis as `description` (same as Item). */
  description?: string;
  duration_ms?: number;
  year?: number;
}

interface SeasonData {
  season: number;
  episodes: EpisodeRowData[];
}

/* ───────────────────────────  authorised fetch  ─────────────────────────────
 * The shared client owns most endpoints; these three aren't on it. Read the
 * configured API base + bearer the same way the client does (authStore) so the
 * request is authorised and tracks the connected server. */

function apiBase(): string {
  return (authStore.getApiBase() ?? '').replace(/\/+$/, '');
}

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });
  const t = authStore.getToken();
  if (t) headers.set('Authorization', `Bearer ${t}`);
  const r = await fetch(`${apiBase()}/v1${path}`, { headers, signal });
  if (!r.ok) throw new Error(`chino-api ${r.status}`);
  return (await r.json()) as T;
}

/** GET /v1/series/{id}/episodes — seasons + episodes for a series. */
async function fetchSeasons(seriesId: string, signal?: AbortSignal): Promise<SeasonData[]> {
  const j = await getJSON<{ seasons?: SeasonData[] }>(
    `/series/${encodeURIComponent(seriesId)}/episodes`,
    signal,
  );
  return (j.seasons ?? []).map((s) => ({ season: s.season, episodes: s.episodes ?? [] }));
}

/** GET /v1/items/{id}/progress — saved resume position (seconds). */
async function fetchResumeSec(itemId: string, signal?: AbortSignal): Promise<number> {
  try {
    const j = await getJSON<{ position_sec?: number }>(
      `/items/${encodeURIComponent(itemId)}/progress`,
      signal,
    );
    return typeof j?.position_sec === 'number' ? j.position_sec : 0;
  } catch {
    // No saved position (404 on a never-played item) → start fresh.
    return 0;
  }
}

/** GET /v1/series/{id}/next-episode — the episode that should play next. */
async function fetchNextEpisodeId(seriesId: string): Promise<string | null> {
  try {
    const j = await getJSON<{ id?: string }>(
      `/series/${encodeURIComponent(seriesId)}/next-episode`,
    );
    return j?.id ?? null;
  } catch {
    return null;
  }
}

/* ──────────────────────────────  helpers  ──────────────────────────────────*/

/** "Resume 1:23:45" / "Resume 4:05" — h:mm:ss when over an hour, else m:ss. */
function formatHM(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/** Total-runtime label — "1h 48m" / "42m" / null when unknown. */
function runtimeLabel(durationMs?: number): string | null {
  const min = durationMs ? Math.round(durationMs / 60_000) : 0;
  if (min <= 0) return null;
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

/** Prefer a YouTube "Official Trailer"; fall back to any trailer. Mirrors the
 *  pickTrailer in both reference clients. */
function pickTrailer(item: Item): NonNullable<Item['trailers']>[number] | null {
  const trailers = item.trailers ?? [];
  if (trailers.length === 0) return null;
  const yt = trailers.filter((t) => (t.site ?? '').toLowerCase().includes('youtube'));
  const pool = yt.length ? yt : trailers;
  const official = pool.find(
    (t) => /official/i.test(t.title ?? '') && /trailer/i.test(t.title ?? ''),
  );
  if (official) return official;
  return pool.find((t) => /trailer/i.test(t.title ?? '')) ?? pool[0];
}

/** Up to two initials from a name, e.g. "Greta Gerwig" → "GG". */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0]?.toUpperCase() ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0]?.toUpperCase() ?? '') : '';
  return (first + last) || '?';
}

/* ──────────────────────────────  screen  ───────────────────────────────────*/

interface DetailScreenProps {
  /** Catalogue id from the route (/detail/:id). */
  id: string;
}

/**
 * Detail screen. Fetches the item, its saved resume position, similar titles
 * and (for series) its episodes in parallel, then renders the hero + actions +
 * shelves. Re-runs cleanly when `id` changes (the integrator reuses the screen
 * across navigations between detail pages, e.g. cast → person → back, or a
 * "More like this" selection).
 */
export default function DetailScreen({ id }: DetailScreenProps): JSX.Element {
  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resumeSec, setResumeSec] = useState(0);
  const [seasons, setSeasons] = useState<SeasonData[]>([]);
  const [similar, setSimilar] = useState<Item[]>([]);
  const [streamToken, setStreamToken] = useState<string>('');

  // Watchlist + watched state, seeded from the loaded data / lists and flipped
  // optimistically on action (web + androidtv both swallow the network result
  // and let the next load reconcile).
  const [inWatchlist, setInWatchlist] = useState(false);
  const [watched, setWatched] = useState(false);
  // Default-list id, resolved once so the "+" fast-path knows where to add.
  const defaultListIdRef = useRef<string | null>(null);
  // Guards re-entrant Play while the series next-episode lookup is in flight.
  const [resolvingPlay, setResolvingPlay] = useState(false);

  // BACK pops the route (matches every other screen).
  useRemoteKey(TVKey.BACK, () => back());

  // Primary load. AbortController so a fast id change doesn't race a stale
  // response into state. Resets all derived state up front.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setItem(null);
    setResumeSec(0);
    setSeasons([]);
    setSimilar([]);

    // Stream token authorises poster + backdrop URLs; failure just yields
    // un-tokenised URLs (the artwork proxy may still 401 — non-fatal to layout).
    void api
      .streamToken()
      .then((t) => setStreamToken(t))
      .catch(() => setStreamToken(''));

    // Item + progress + similar in parallel; episodes only once we know it's a
    // series (don't burn the request on a movie).
    void (async () => {
      try {
        const [loaded, resume, sim] = await Promise.all([
          api.getItem(id, 'cast,similar,segments,trailers,subtitles'),
          fetchResumeSec(id, ctrl.signal),
          api.similar(id, 12).catch(() => [] as Item[]),
        ]);
        if (ctrl.signal.aborted) return;
        setItem(loaded);
        setResumeSec(resume);
        setSimilar(sim);
        setWatched(loaded.watched_at != null || !!loaded.watched);
        if (loaded.type === 'series') {
          const s = await fetchSeasons(id, ctrl.signal).catch(() => [] as SeasonData[]);
          if (!ctrl.signal.aborted) setSeasons(s);
        }
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setError(e instanceof Error ? e.message : 'Could not load item');
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [id]);

  // Resolve the saved-state of the watchlist "+" by scanning the user's lists
  // for this item. Also caches the default list id for the add fast-path.
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const lists = await api.listWatchlists();
        if (ctrl.signal.aborted) return;
        const def = lists.find((l) => l.is_default) ?? lists[0] ?? null;
        defaultListIdRef.current = def?.id ?? null;
        // Membership: a list reports its count but not its members, so we ask
        // each list's detail and check whether this id is inside. Cheap on a
        // handful of lists; web uses a dedicated memberships endpoint we don't
        // surface here. Best-effort — a failure just leaves the icon empty.
        const membership = await Promise.all(
          lists.map((l) =>
            api
              .getWatchlist(l.id)
              .then((w) => w.items.some((it) => it.id === id))
              .catch(() => false),
          ),
        );
        if (!ctrl.signal.aborted) setInWatchlist(membership.some(Boolean));
      } catch {
        /* lists unavailable — leave the icon in its default empty state */
      }
    })();
    return () => ctrl.abort();
  }, [id]);

  // Open the player on the right id: movies play themselves; series resolve the
  // next-up (else first) episode — the series root has no master.m3u8.
  const goPlay = useCallback(
    (resume: boolean) => {
      if (resolvingPlay || !item) return;
      const open = (targetId: string) => {
        // The player auto-resumes by default; force a clean start with
        // ?startover=1, matching chino-web's goPlayer. resume=true keeps the
        // saved position.
        const qp = resume ? '' : resumeSec > 30 ? '?startover=1' : '';
        navigate(`/player/${encodeURIComponent(targetId)}${qp}`);
      };
      if (item.type !== 'series') {
        open(item.id);
        return;
      }
      setResolvingPlay(true);
      void (async () => {
        try {
          const next = await fetchNextEpisodeId(item.id);
          const firstEpisode = seasons[0]?.episodes[0]?.id;
          open(next ?? firstEpisode ?? item.id);
        } finally {
          setResolvingPlay(false);
        }
      })();
    },
    [resolvingPlay, item, resumeSec, seasons],
  );

  const toggleWatchlist = useCallback(() => {
    if (!item) return;
    const next = !inWatchlist;
    setInWatchlist(next); // optimistic
    const listId = defaultListIdRef.current;
    void (async () => {
      try {
        // No default list yet (first-ever save) → create one, then add.
        let target = listId;
        if (next && !target) {
          const created = await api.createWatchlist('Watchlist');
          target = created.id;
          defaultListIdRef.current = created.id;
        }
        if (!target) return;
        if (next) await api.addToWatchlist(target, item.id);
        else await api.removeFromWatchlist(target, item.id);
      } catch {
        /* swallow — next load reconciles, web does the same */
      }
    })();
  }, [item, inWatchlist]);

  const toggleWatched = useCallback(() => {
    if (!item) return;
    const next = !watched;
    setWatched(next); // optimistic
    void (next ? api.setWatched(item.id) : api.unsetWatched(item.id)).catch(() => undefined);
  }, [item, watched]);

  const onEpisodeWatched = useCallback((episodeId: string, makeWatched: boolean) => {
    // Optimistically flip the loaded episode's watched_at so the row's green
    // check updates instantly, then POST/DELETE (web/androidtv parity).
    setSeasons((prev) =>
      prev.map((s) =>
        s.episodes.some((e) => e.id === episodeId)
          ? {
              ...s,
              episodes: s.episodes.map((e) =>
                e.id === episodeId ? { ...e, watched_at: makeWatched ? 'now' : null } : e,
              ),
            }
          : s,
      ),
    );
    void (makeWatched ? api.setWatched(episodeId) : api.unsetWatched(episodeId)).catch(
      () => undefined,
    );
  }, []);

  if (loading) return <Spinner label="Loading…" />;
  if (error || !item) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-bg p-16 text-center text-red">
        Could not load this title{error ? `: ${error}` : ''}.
      </div>
    );
  }

  const canResume = resumeSec > 30;
  const isSeries = item.type === 'series';
  const trailer = pickTrailer(item);
  const backdrop = streamToken
    ? `${apiBase()}/v1/items/${encodeURIComponent(item.id)}/backdrop?stream=${encodeURIComponent(streamToken)}`
    : item.backdrop_url ?? '';
  const poster = api.posterUrl(item, streamToken || undefined);
  const runtime = runtimeLabel(item.duration_ms);

  return (
    <div className="relative min-h-screen w-full overflow-y-auto bg-bg text-text">
      {/* Hero backdrop — top band of the page; a vertical gradient fades it into
          the page background so the title + CTAs sit on top of it. Mirrors
          chino-web's aspect-[21/9] hero + androidtv's 560dp backdrop. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[60vh] w-full">
        {backdrop ? (
          <img src={backdrop} alt="" className="h-full w-full object-cover opacity-70" />
        ) : (
          <div className="h-full w-full bg-surface" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/60 to-transparent" />
      </div>

      {/* Content overlaps the lower part of the backdrop. */}
      <div className="relative z-10 px-12 pb-16 pt-[34vh]">
        <div className="flex gap-10">
          {/* Poster. */}
          <div className="aspect-[2/3] w-56 shrink-0 overflow-hidden rounded-lg bg-surface shadow-2xl">
            {poster ? (
              <img src={poster} alt={item.title} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-border-2">
                <ImageIcon className="h-10 w-10" />
              </div>
            )}
          </div>

          {/* Title + meta + actions + description. */}
          <div className="flex max-w-4xl flex-1 flex-col gap-3">
            <h1 className="text-5xl font-bold text-white">{item.title}</h1>
            {item.tagline ? (
              <p className="italic text-muted">{item.tagline}</p>
            ) : null}

            <MetaRow
              year={item.year}
              runtime={runtime}
              rating={item.rating}
              kind={item.type}
            />

            {item.genres && item.genres.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {item.genres.map((g) => (
                  <span
                    key={g}
                    className="rounded-full border border-border-2 bg-surface-2 px-3 py-1 text-sm text-text"
                  >
                    {g}
                  </span>
                ))}
              </div>
            ) : null}

            {/* Action row. Play/Resume is the first focusable so the screen
                lands on it. */}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <PrimaryAction
                label={resolvingPlay ? 'Loading…' : canResume ? `Resume ${formatHM(resumeSec)}` : 'Play'}
                onEnter={() => goPlay(canResume)}
                autoFocus
              />
              {canResume ? (
                <SecondaryAction label="Start over" onEnter={() => goPlay(false)} />
              ) : null}
              {trailer?.url ? (
                <SecondaryAction
                  label="Trailer"
                  icon={<Youtube className="h-5 w-5" />}
                  onEnter={() => {
                    // No in-app browser on Tizen; hand the URL to the platform
                    // launcher if available, else open in a new context.
                    try {
                      window.open(trailer.url, '_blank');
                    } catch {
                      /* sandboxed — ignore */
                    }
                  }}
                />
              ) : null}
              <ActionCircle
                icon={inWatchlist ? <Check className="h-5 w-5 stroke-[3]" /> : <Plus className="h-5 w-5" />}
                active={inWatchlist}
                label={inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
                onEnter={toggleWatchlist}
              />
              <ActionCircle
                icon={watched ? <Check className="h-5 w-5 stroke-[3]" /> : <Eye className="h-5 w-5" />}
                active={watched}
                label={watched ? 'Mark as unwatched' : 'Mark as watched'}
                onEnter={toggleWatched}
              />
            </div>

            {item.description ? (
              <p className="mt-2 max-w-3xl whitespace-pre-line leading-relaxed text-text">
                {item.description}
              </p>
            ) : (
              <p className="mt-2 italic text-muted">No description available.</p>
            )}

            <FooterGrid item={item} />
          </div>
        </div>

        <CastCrewSection cast={item.cast ?? []} />

        {isSeries && seasons.length > 0 ? (
          <EpisodesBlock
            seasons={seasons}
            streamToken={streamToken}
            onPlayEpisode={(epId) => navigate(`/player/${encodeURIComponent(epId)}`)}
            onToggleEpisodeWatched={onEpisodeWatched}
          />
        ) : null}

        {similar.length > 0 ? (
          <SimilarSection items={similar} streamToken={streamToken} />
        ) : null}
      </div>
    </div>
  );
}

/* ─────────────────────────────  action row  ────────────────────────────────*/

function PrimaryAction({
  label,
  onEnter,
  autoFocus,
}: {
  label: string;
  onEnter: () => void;
  autoFocus?: boolean;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className="inline-flex cursor-default select-none items-center gap-2 rounded-full bg-accent px-6 py-3 text-xl font-semibold text-bg data-[focused=true]:bg-accent"
    >
      <Play className="h-5 w-5 fill-current" />
      {label}
    </div>
  );
}

function SecondaryAction({
  label,
  icon,
  onEnter,
}: {
  label: string;
  icon?: JSX.Element;
  onEnter: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className="inline-flex cursor-default select-none items-center gap-2 rounded-full bg-white/10 px-5 py-3 text-xl font-medium text-white data-[focused=true]:bg-white data-[focused=true]:text-black"
    >
      {icon}
      {label}
    </div>
  );
}

/** Circular icon toggle (watchlist "+"/✓, watched eye/✓). Tinted green when
 *  active; inverts on focus. Mirrors androidtv's DetailActionCircle. */
function ActionCircle({
  icon,
  active,
  label,
  onEnter,
}: {
  icon: JSX.Element;
  active: boolean;
  label: string;
  onEnter: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter });
  return (
    <div
      ref={ref}
      data-focused={focused}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={[
        'flex h-12 w-12 cursor-default select-none items-center justify-center rounded-full',
        focused
          ? 'bg-white text-black'
          : active
            ? 'bg-signal-green text-white'
            : 'bg-white/10 text-white',
      ].join(' ')}
    >
      {icon}
    </div>
  );
}

/* ───────────────────────────────  meta row  ────────────────────────────────*/

function MetaRow({
  year,
  runtime,
  rating,
  kind,
}: {
  year?: number;
  runtime: string | null;
  rating?: number;
  kind?: string;
}): JSX.Element {
  const parts: JSX.Element[] = [];
  if (year != null) parts.push(<span key="y">{year}</span>);
  if (runtime) parts.push(<span key="r">{runtime}</span>);
  if (rating != null) {
    parts.push(
      <span key="rt" className="inline-flex items-center gap-1">
        <Star className="h-4 w-4 fill-accent text-accent" />
        {rating.toFixed(1)}
      </span>,
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 text-base text-text">
      {parts.map((p, i) => (
        <span key={p.key} className="inline-flex items-center gap-3">
          {i > 0 ? <span className="text-muted">•</span> : null}
          {p}
        </span>
      ))}
      {kind ? (
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs uppercase tracking-wide">
          {kind}
        </span>
      ) : null}
    </div>
  );
}

/* ─────────────────────────  footer (subs / analyzed)  ───────────────────────*/

function FooterGrid({ item }: { item: Item }): JSX.Element | null {
  const subtitleLabel = Array.from(
    new Set((item.subtitles ?? []).map((s) => s.label || s.lang).filter(Boolean)),
  ).join(', ');
  const seg = item.segments;
  const analyzedLabel =
    seg && seg.count > 0
      ? [seg.has_intro && 'Intro', seg.has_credits && 'Credits', seg.has_recap && 'Recap']
          .filter(Boolean)
          .join(' · ') || 'Segments available'
      : '';
  if (!subtitleLabel && !analyzedLabel) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-10 text-base">
      {subtitleLabel ? <FooterColumn header="Subtitles" value={subtitleLabel} /> : null}
      {analyzedLabel ? <FooterColumn header="Analyzed" value={analyzedLabel} /> : null}
    </div>
  );
}

function FooterColumn({ header, value }: { header: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted">{header}</span>
      <span className="text-text">{value}</span>
    </div>
  );
}

/* ───────────────────────────  cast & crew shelf  ────────────────────────────
 * Directors first (web order), then actors. Each entry is a focusable card; a
 * credit carrying a person_id becomes a tap target → /person/:id, otherwise it
 * stays display-only but still holds focus so the row is browsable. */

function CastCrewSection({ cast }: { cast: CastEntry[] }): JSX.Element | null {
  const directors = cast.filter((c) => (c.role ?? '').toLowerCase() === 'director');
  const actors = cast.filter((c) => !c.role || c.role.toLowerCase() === 'actor');
  const ordered = [...directors, ...actors];
  if (ordered.length === 0) return null;
  return (
    <section className="mt-12">
      <h2 className="mb-4 text-2xl font-semibold text-white">Cast &amp; crew</h2>
      <div className="flex gap-4 overflow-x-hidden py-2">
        {ordered.map((member, i) => (
          <CastCard key={`${member.role}:${member.name}:${i}`} member={member} />
        ))}
      </div>
    </section>
  );
}

function CastCard({ member }: { member: CastEntry }): JSX.Element {
  const linkable = !!member.person_id;
  const { ref, focused } = useFocusable({
    onEnter: linkable
      ? () => navigate(`/person/${encodeURIComponent(member.person_id as string)}`)
      : undefined,
  });
  const roleLabel = (() => {
    const r = (member.role ?? '').toLowerCase();
    if (r === 'director') return 'Director';
    if (r === 'actor') return 'Actor';
    if (!member.role) return 'Cast';
    return member.role.charAt(0).toUpperCase() + member.role.slice(1);
  })();
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={`flex w-32 shrink-0 cursor-default select-none flex-col items-center gap-2 rounded-lg p-2 ${
        focused ? 'bg-surface-2' : ''
      }`}
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-surface text-2xl font-semibold text-text">
        {initialsOf(member.name)}
      </div>
      <span className="line-clamp-2 text-center text-sm font-medium text-white">{member.name}</span>
      <span className="text-xs text-muted">{roleLabel}</span>
    </div>
  );
}

/* ─────────────────────────  episodes (series only)  ─────────────────────────
 * Vertical accordion: an "Episodes" heading, one collapsible season card per
 * season (header focusable, ENTER toggles), expanding into full-width episode
 * rows (16:9 thumb + SxxExx label + title + runtime + 2-line synopsis + a
 * trailing per-episode watched toggle). Mirrors chino-web EpisodesList +
 * androidtv EpisodesBlock. */

function EpisodesBlock({
  seasons,
  streamToken,
  onPlayEpisode,
  onToggleEpisodeWatched,
}: {
  seasons: SeasonData[];
  streamToken: string;
  onPlayEpisode: (episodeId: string) => void;
  onToggleEpisodeWatched: (episodeId: string, watched: boolean) => void;
}): JSX.Element {
  return (
    <section className="mt-12 flex flex-col gap-4">
      <h2 className="text-2xl font-semibold text-white">Episodes</h2>
      {seasons.map((season, i) => (
        <SeasonSection
          key={season.season}
          season={season}
          streamToken={streamToken}
          initiallyExpanded={i === 0}
          onPlayEpisode={onPlayEpisode}
          onToggleEpisodeWatched={onToggleEpisodeWatched}
        />
      ))}
    </section>
  );
}

function SeasonSection({
  season,
  streamToken,
  initiallyExpanded,
  onPlayEpisode,
  onToggleEpisodeWatched,
}: {
  season: SeasonData;
  streamToken: string;
  initiallyExpanded: boolean;
  onPlayEpisode: (episodeId: string) => void;
  onToggleEpisodeWatched: (episodeId: string, watched: boolean) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const { ref, focused } = useFocusable({ onEnter: () => setExpanded((v) => !v) });
  return (
    <div className="overflow-hidden rounded-xl bg-surface">
      <div
        ref={ref}
        data-focused={focused}
        className={`flex cursor-default select-none items-center gap-4 px-5 py-4 ${
          focused ? 'bg-border' : ''
        }`}
      >
        <span className="font-semibold text-white">Season {season.season}</span>
        <span className="flex-1 text-base text-muted">{season.episodes.length} episodes</span>
        {expanded ? (
          <ChevronDown className="h-5 w-5 text-muted" />
        ) : (
          <ChevronRight className="h-5 w-5 text-muted" />
        )}
      </div>
      {expanded
        ? season.episodes.map((ep, i) => (
            <div key={ep.id}>
              {i > 0 ? <div className="h-px w-full bg-border" /> : null}
              <EpisodeRow
                episode={ep}
                streamToken={streamToken}
                onPlay={() => onPlayEpisode(ep.id)}
                onToggleWatched={() => onToggleEpisodeWatched(ep.id, ep.watched_at == null)}
              />
            </div>
          ))
        : null}
    </div>
  );
}

function EpisodeRow({
  episode,
  streamToken,
  onPlay,
  onToggleWatched,
}: {
  episode: EpisodeRowData;
  streamToken: string;
  onPlay: () => void;
  onToggleWatched: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter: onPlay });
  const watched = episode.watched_at != null;
  const enc = streamToken ? encodeURIComponent(streamToken) : '';
  const thumb = enc
    ? `${apiBase()}/v1/items/${encodeURIComponent(episode.id)}/backdrop?stream=${enc}`
    : '';
  const label =
    episode.episode_number != null
      ? `S${String(episode.season_number ?? 0).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`
      : null;
  const mins = episode.duration_ms ? Math.round(episode.duration_ms / 60_000) : 0;
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div
        ref={ref}
        data-focused={focused}
        className={`flex flex-1 cursor-default select-none items-center gap-4 rounded-lg p-1 ${
          focused ? 'bg-border' : ''
        }`}
      >
        <div className="aspect-video w-40 shrink-0 overflow-hidden rounded-md bg-bg">
          {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            {label ? <span className="shrink-0 text-sm font-semibold text-accent">{label}</span> : null}
            <span className="truncate font-medium text-white">{episode.title}</span>
            {mins > 0 ? <span className="shrink-0 text-sm text-muted">{mins}m</span> : null}
          </div>
          {episode.description ? (
            <p className="line-clamp-2 text-sm text-text">{episode.description}</p>
          ) : null}
        </div>
      </div>
      <EpisodeWatchedToggle watched={watched} onToggle={onToggleWatched} />
    </div>
  );
}

function EpisodeWatchedToggle({
  watched,
  onToggle,
}: {
  watched: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter: onToggle });
  return (
    <div
      ref={ref}
      data-focused={focused}
      title={watched ? 'Mark episode as unwatched' : 'Mark episode as watched'}
      aria-label={watched ? 'Mark episode as unwatched' : 'Mark episode as watched'}
      aria-pressed={watched}
      className={[
        'flex h-10 w-10 shrink-0 cursor-default select-none items-center justify-center rounded-full',
        focused ? 'bg-white text-black' : watched ? 'bg-signal-green text-white' : 'bg-white/10 text-muted',
      ].join(' ')}
    >
      {watched ? <Check className="h-5 w-5 stroke-[3]" /> : <Eye className="h-5 w-5" />}
    </div>
  );
}

/* ───────────────────────────  more like this  ──────────────────────────────*/

function SimilarSection({
  items,
  streamToken,
}: {
  items: Item[];
  streamToken: string;
}): JSX.Element {
  return (
    <section className="mt-12">
      <h2 className="mb-4 text-2xl font-semibold text-white">More like this</h2>
      <div className="flex gap-4 overflow-x-hidden py-3">
        {items.map((it) => (
          <SimilarCard key={it.id} item={it} streamToken={streamToken} />
        ))}
      </div>
    </section>
  );
}

function SimilarCard({ item, streamToken }: { item: Item; streamToken: string }): JSX.Element {
  const { ref, focused } = useFocusable({
    onEnter: () => navigate(`/detail/${encodeURIComponent(item.id)}`),
  });
  const poster = api.posterUrl(item, streamToken || undefined);
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={`w-44 shrink-0 cursor-default select-none rounded-lg bg-surface transition-transform ${
        focused ? 'scale-105' : ''
      }`}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface-2">
        {poster ? (
          <img src={poster} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-border-2">
            <ImageIcon className="h-8 w-8" />
          </div>
        )}
      </div>
      <div className="p-3">
        <h3 className="truncate font-medium text-text">{item.title}</h3>
        <div className="mt-1 flex items-center gap-2 text-sm text-muted">
          {item.year ? <span>{item.year}</span> : null}
          {item.rating != null ? (
            <>
              {item.year ? <span>•</span> : null}
              <span className="text-accent">{item.rating.toFixed(1)}</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
