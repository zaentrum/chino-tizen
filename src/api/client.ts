import type {
  AppConfig,
  ContinueWatchingItem,
  FeedbackResult,
  Item,
  ListResult,
  NextEpisode,
  Person,
  PersonDetail,
  PlayInfo,
  PlayInfoTrack,
  Season,
  Segment,
  Subtitle,
  Watchlist,
} from './types';
import { apiUrl, withStreamToken } from '@/lib/artwork';
import { acceptLanguage } from '@/lib/people';

/**
 * Typed client for chino-api's BFF. Endpoint paths/params mirror chino-web's
 * fetch layer (src/hooks/*, src/lib/feedback.ts) and are confirmed against
 * chino-api/internal/http/router.go. Authority notes inline per method.
 *
 * Base URL: the neutral self-host client is configured with a server, and
 * chino-api's GET /api/config reports an `apiBase` that already includes the
 * `/api` suffix (e.g. "https://host/api"). androidtv's ServerBootstrap uses
 * exactly this value as its Retrofit base. So `baseUrl` here is the API root
 * ENDING AT `/api` (no trailing slash). Versioned routes append `/v1/...`;
 * the discovery + health docs append `/config` / `/healthz`.
 *
 * Auth: the OIDC bearer goes on the Authorization header (read fresh per
 * request via getToken so a silent renew doesn't need a client rebuild).
 * Media-asset URLs handed to <video>/<img>/<track> can't carry headers, so
 * those carry the credential in the query string instead — the long-lived
 * stream token as `?stream=` (artwork, HLS, subtitles, trickplay) per the
 * stream-token group in router.go, or `?token=` (OIDC) on the legacy
 * progressive /play route.
 */
export class ChinoClient {
  private readonly baseUrlFn: () => string;
  private readonly getToken: () => string | null;

  constructor(opts: { baseUrl: string | (() => string); getToken: () => string | null }) {
    // baseUrl accepted as a string OR a thunk so the instance can track the
    // configured server as it changes (see @/api/instance). Either way we
    // normalise to a no-trailing-slash API root at call time.
    this.baseUrlFn =
      typeof opts.baseUrl === 'function' ? opts.baseUrl : () => opts.baseUrl as string;
    this.getToken = opts.getToken;
  }

  /** API root ending at `/api`, trailing slash stripped. */
  private base(): string {
    return (this.baseUrlFn() || '').replace(/\/+$/, '');
  }

  private authHeaders(extra?: HeadersInit): Headers {
    const h = new Headers(extra);
    const t = this.getToken();
    if (t) h.set('Authorization', `Bearer ${t}`);
    return h;
  }

  /** GET <base>/v1<path> with the bearer header, parsing JSON. */
  private async getJSON<T>(path: string, extraHeaders?: HeadersInit): Promise<T> {
    const r = await fetch(`${this.base()}/v1${path}`, { headers: this.authHeaders(extraHeaders) });
    if (!r.ok) throw new Error(`chino-api ${r.status}`);
    return (await r.json()) as T;
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  /**
   * GET /api/config — the unauthenticated, CORS-open discovery doc. The wire
   * shape carries `oidcClientId` as a { tv, mobile, web } map; we flatten it
   * to the TV client id. `baseUrl` here is the server origin INCLUDING `/api`
   * (matching the value /api/config itself reports back as `apiBase`).
   */
  static async getAppConfig(baseUrl: string): Promise<AppConfig> {
    const root = (baseUrl || '').replace(/\/+$/, '');
    const r = await fetch(`${root}/config`, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`chino-api ${r.status}`);
    const j = (await r.json()) as {
      apiBase?: string;
      oidcIssuer?: string;
      oidcClientId?: string | { tv?: string; mobile?: string; web?: string };
    };
    const clientId =
      typeof j.oidcClientId === 'string'
        ? j.oidcClientId
        : j.oidcClientId?.tv ?? j.oidcClientId?.web ?? '';
    return {
      oidcIssuer: j.oidcIssuer ?? '',
      oidcClientId: clientId,
      apiBase: j.apiBase,
    };
  }

  // ---------------------------------------------------------------------------
  // Catalogue
  // ---------------------------------------------------------------------------

  /**
   * GET /v1/items — browse / search the catalogue. Query params match
   * chino-web's useItems / usePagedItems exactly (snake_case year_min /
   * year_max / rating_min). The response wraps items in
   * { product, items, source }; we normalise to ListResult (the endpoint
   * does not return a total/limit/offset, so those are derived). Image URLs
   * carry the stream token only when one is passed in (the screens fold the
   * token in via posterUrl); the raw list keeps relative poster_url values
   * so the caller can decide.
   */
  async listItems(p: {
    type?: string;
    q?: string;
    genre?: string;
    sort?: string;
    year_min?: number;
    year_max?: number;
    rating_min?: number;
    unwatched?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<ListResult> {
    const params = new URLSearchParams();
    if (p.q) params.set('q', p.q);
    if (p.type) params.set('type', p.type);
    if (p.genre) params.set('genre', p.genre);
    if (p.sort) params.set('sort', p.sort);
    if (p.year_min != null) params.set('year_min', String(p.year_min));
    if (p.year_max != null) params.set('year_max', String(p.year_max));
    if (p.rating_min != null) params.set('rating_min', String(p.rating_min));
    if (p.unwatched) params.set('unwatched', 'true');
    const limit = p.limit ?? 50;
    const offset = p.offset ?? 0;
    params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const j = await this.getJSON<{ items?: Item[] }>(`/items?${params.toString()}`);
    const items = (j.items ?? []).map(stampWatched);
    return { items, total: items.length, limit, offset };
  }

  /**
   * GET /v1/items/{id} — single item with rich associations expanded. The
   * server expands genres/cast/subtitles/trailers/segments unconditionally,
   * so `include` is accepted for forward-compat but only sent when given.
   */
  async getItem(id: string, include?: string): Promise<Item> {
    const qs = include ? `?include=${encodeURIComponent(include)}` : '';
    const item = await this.getJSON<Item>(`/items/${encodeURIComponent(id)}${qs}`);
    return stampWatched(item);
  }

  /** GET /v1/series/{id}/episodes — every episode, by season. Wire:
   *  { series_id, seasons: [{ season, episodes }] | null, count }. */
  async seriesEpisodes(seriesId: string): Promise<Season[]> {
    const j = await this.getJSON<{ seasons?: { season: number; episodes?: Item[] | null }[] | null }>(
      `/series/${encodeURIComponent(seriesId)}/episodes`,
    );
    return (j.seasons ?? []).map((s) => ({
      season: s.season,
      episodes: (s.episodes ?? []).map(stampWatched),
    }));
  }

  /** GET /v1/series/{id}/next-episode[?after={episodeId}] — see NextEpisode.
   *  The wire wraps the episode as `next`; there is no flat `{ id }`. */
  async nextEpisode(seriesId: string, afterEpisodeId?: string): Promise<NextEpisode> {
    const qs = afterEpisodeId ? `?after=${encodeURIComponent(afterEpisodeId)}` : '';
    const j = await this.getJSON<{ next?: Item | null; anchor?: string; reason?: string }>(
      `/series/${encodeURIComponent(seriesId)}/next-episode${qs}`,
    );
    return { next: j.next ? stampWatched(j.next) : null, anchor: j.anchor, reason: j.reason };
  }

  /** GET /v1/genres — the catalogue's genres, sorted: { genres: [...] }. Rows
   *  of the list endpoints carry no genres (only GET /items/{id} does), so the
   *  browse chips and the Home genre rails come from here, as on chino-web. */
  async genres(): Promise<string[]> {
    const j = await this.getJSON<{ genres?: string[] | null }>(`/genres`);
    return (j.genres ?? []).filter((g) => typeof g === 'string' && g.trim() !== '');
  }

  /** GET /v1/items/{id}/similar — "More like this". Returns [] on no match.
   *  Wire shape is { items, total }. */
  async similar(id: string, limit = 12): Promise<Item[]> {
    const j = await this.getJSON<{ items?: Item[] }>(
      `/items/${encodeURIComponent(id)}/similar?limit=${limit}`,
    );
    return (j.items ?? []).map(stampWatched);
  }

  // ---------------------------------------------------------------------------
  // People
  // ---------------------------------------------------------------------------

  /** GET /v1/people?q=&limit= — cast/crew name search. Wire: { people, total }. */
  async searchPeople(q: string, limit = 20): Promise<Person[]> {
    if (!q) return [];
    const params = new URLSearchParams({ q, limit: String(limit) });
    const j = await this.getJSON<{ people?: Person[] }>(`/people?${params.toString()}`);
    return j.people ?? [];
  }

  /**
   * GET /v1/people/{id}?limit= — a person, what the catalog knows about them
   * and their filmography (PersonDetail, flat on the wire). The biography
   * comes in the TV's languages, most wanted first (Accept-Language, as
   * chino-web sends it), else English. 404 surfaces as a thrown error.
   */
  async getPerson(id: string, limit = 100): Promise<PersonDetail> {
    const languages = acceptLanguage(
      typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language],
    );
    const j = await this.getJSON<PersonDetail>(
      `/people/${encodeURIComponent(id)}?limit=${limit}`,
      languages ? { 'Accept-Language': languages } : undefined,
    );
    return { ...j, items: (j.items ?? []).map(stampWatched) };
  }

  // ---------------------------------------------------------------------------
  // Personal state — continue watching, watch flag, progress
  // ---------------------------------------------------------------------------

  /** GET /v1/me/continue-watching — resume rail (in-progress + next-up). Wire:
   *  { items: [Item + position_sec, duration_sec, series_title?, up_next?] }. */
  async continueWatching(): Promise<ContinueWatchingItem[]> {
    const j = await this.getJSON<{ items?: ContinueWatchingItem[] }>(`/me/continue-watching`);
    return (j.items ?? []).map(stampWatched);
  }

  /**
   * GET /v1/items/{id}/progress — the saved resume position, in seconds. Wire:
   * { position_sec }, 0 when the user never played the item. This is the only
   * place a title's position comes from (GET /items/{id} carries none). Throws
   * when it cannot be read, so the player can tell "nothing saved" from
   * "unknown" and not overwrite a position it never saw.
   */
  async getProgress(id: string): Promise<number> {
    const j = await this.getJSON<{ position_sec?: number }>(
      `/items/${encodeURIComponent(id)}/progress`,
    );
    const pos = j?.position_sec;
    return typeof pos === 'number' && Number.isFinite(pos) && pos > 0 ? pos : 0;
  }

  /** POST /v1/items/{id}/progress — resume position. Called ~every 10s while
   *  watching. Body is { position_sec, duration_sec } in whole seconds (the
   *  server decodes ints); 204 on success. It overwrites the one position the
   *  user has on every device, so callers post only what they played to. */
  async postProgress(id: string, positionSec: number, durationSec: number): Promise<void> {
    const r = await fetch(`${this.base()}/v1/items/${encodeURIComponent(id)}/progress`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ position_sec: positionSec, duration_sec: durationSec }),
      keepalive: true,
    });
    if (!r.ok) throw new Error(`chino-api ${r.status}`);
  }

  /** POST /v1/me/items/{id}/watched — mark watched. */
  async setWatched(id: string): Promise<void> {
    await this.watchedFlag(id, 'POST');
  }

  /** DELETE /v1/me/items/{id}/watched — clear watched. */
  async unsetWatched(id: string): Promise<void> {
    await this.watchedFlag(id, 'DELETE');
  }

  private async watchedFlag(id: string, method: 'POST' | 'DELETE'): Promise<void> {
    const r = await fetch(`${this.base()}/v1/me/items/${encodeURIComponent(id)}/watched`, {
      method,
      headers: this.authHeaders(),
    });
    if (!r.ok) throw new Error(`chino-api ${r.status}`);
  }

  // ---------------------------------------------------------------------------
  // Watchlists (named lists; one default per user)
  // ---------------------------------------------------------------------------

  /** GET /v1/me/watchlists — wire: { lists: [{ id, name, isDefault,
   *  itemCount, createdAt }] }. Normalised to the snake_case contract shape. */
  async listWatchlists(): Promise<Watchlist[]> {
    const j = await this.getJSON<{ lists?: RawWatchlist[] }>(`/me/watchlists`);
    return (j.lists ?? []).map(toWatchlist);
  }

  /** GET /v1/me/watchlists/{id} — wire: { id, name, isDefault, items:[itemId] }.
   *  We return the list meta plus the *items* it contains; the membership
   *  endpoint only yields ids, so we hydrate each via getItem in parallel. */
  async getWatchlist(id: string): Promise<{ list: Watchlist; items: Item[] }> {
    const detail = await this.getJSON<{
      id: string;
      name: string;
      isDefault?: boolean;
      items?: string[];
    }>(`/me/watchlists/${encodeURIComponent(id)}`);
    const ids = detail.items ?? [];
    const items = await Promise.all(
      ids.map((itemId) => this.getItem(itemId).catch(() => null)),
    );
    return {
      list: {
        id: detail.id,
        name: detail.name,
        is_default: detail.isDefault,
        count: ids.length,
      },
      items: items.filter((it): it is Item => it != null),
    };
  }

  /** GET /v1/me/watchlists/memberships?ids=a,b — which of the user's lists
   *  hold each item: { memberships: { itemId: [listId, …] } }, items in no
   *  list left out. One request, where reading every list hydrates each of
   *  its items. */
  async watchlistMemberships(itemIds: string[]): Promise<Record<string, string[]>> {
    if (itemIds.length === 0) return {};
    const ids = itemIds.map((id) => encodeURIComponent(id)).join(',');
    const j = await this.getJSON<{ memberships?: Record<string, string[]> | null }>(
      `/me/watchlists/memberships?ids=${ids}`,
    );
    return j.memberships ?? {};
  }

  /** POST /v1/me/watchlists — create a named list. Body { name }. */
  async createWatchlist(name: string): Promise<Watchlist> {
    const r = await fetch(`${this.base()}/v1/me/watchlists`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(`chino-api ${r.status}`);
    return toWatchlist((await r.json()) as RawWatchlist);
  }

  /** PATCH /v1/me/watchlists/{id} — rename. Body { name }. */
  async renameWatchlist(id: string, name: string): Promise<void> {
    const r = await fetch(`${this.base()}/v1/me/watchlists/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(`chino-api ${r.status}`);
  }

  /** DELETE /v1/me/watchlists/{id}. */
  async deleteWatchlist(id: string): Promise<void> {
    const r = await fetch(`${this.base()}/v1/me/watchlists/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!r.ok) throw new Error(`chino-api ${r.status}`);
  }

  /** PUT /v1/me/watchlists/{listId}/items/{itemId} — add to list. */
  async addToWatchlist(id: string, itemId: string): Promise<void> {
    const r = await fetch(
      `${this.base()}/v1/me/watchlists/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
      { method: 'PUT', headers: this.authHeaders() },
    );
    if (!r.ok) throw new Error(`chino-api ${r.status}`);
  }

  /** DELETE /v1/me/watchlists/{listId}/items/{itemId} — remove from list. */
  async removeFromWatchlist(id: string, itemId: string): Promise<void> {
    const r = await fetch(
      `${this.base()}/v1/me/watchlists/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
      { method: 'DELETE', headers: this.authHeaders() },
    );
    if (!r.ok) throw new Error(`chino-api ${r.status}`);
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  /**
   * GET /v1/items/{id}/play/info?caps= — the server's decision for these
   * caps + the qualities a pick may ask for: a packaged ladder's Auto and
   * rungs (null with fewer than two), else the transcode ladder. The wire
   * entries are { name, label } (a packaged rung adds id, width, height,
   * codec, bitrate); we keep { id: name, label }, what the menu and ?q= use.
   */
  async playInfo(id: string, caps: string): Promise<PlayInfo> {
    const qs = caps ? `?caps=${encodeURIComponent(caps)}` : '';
    const j = await this.getJSON<{
      duration_ms?: number;
      mode?: string;
      default_quality?: string;
      qualities?: { name?: string; label?: string }[] | null;
      audio_tracks?: PlayInfoTrack[] | null;
      subtitle_tracks?: PlayInfoTrack[] | null;
    }>(`/items/${encodeURIComponent(id)}/play/info${qs}`);
    return {
      duration_ms: j.duration_ms ?? 0,
      mode: j.mode,
      default_quality: j.default_quality,
      qualities: (j.qualities ?? []).map((q) => ({
        id: q.name ?? '',
        label: q.label ?? q.name ?? '',
      })),
      audio_tracks: j.audio_tracks ?? [],
      subtitle_tracks: j.subtitle_tracks ?? [],
    };
  }

  /**
   * GET /v1/items/{id}/subtitles — the item's sidecar subtitles. Wire:
   * { subtitles: [{ id, lang, label?, format?, default?, url }] }, `url`
   * origin-relative ("/api/v1/play/subs/{id}.vtt", stream-token group; resolve
   * it with assetUrl). An empty list is the normal case.
   */
  async subtitles(id: string): Promise<Subtitle[]> {
    const j = await this.getJSON<{ subtitles?: Subtitle[] | null }>(
      `/items/${encodeURIComponent(id)}/subtitles`,
    );
    return j.subtitles ?? [];
  }

  /**
   * POST /v1/me/stream-token — mint the long-lived (6 h) stream token used in
   * media-asset URLs (HLS master/segments, artwork, subtitles, trickplay) so
   * an OIDC silent renew doesn't rotate the URL mid-stream. Wire:
   * { stream_token, expires_at }.
   */
  async streamToken(): Promise<string> {
    const r = await fetch(`${this.base()}/v1/me/stream-token`, {
      method: 'POST',
      headers: this.authHeaders(),
    });
    if (!r.ok) throw new Error(`chino-api ${r.status}`);
    const j = (await r.json()) as { stream_token?: string };
    if (!j.stream_token) throw new Error('chino-api: no stream_token in response');
    return j.stream_token;
  }

  /**
   * HLS master playlist URL for the player. Mirrors chino-web PlayerPage:
   * `?stream=<token>&q=<quality>&caps=<caps>`. For a packaged title the
   * server serves the ladder of rungs these caps decode (q=auto) or the one
   * rung q names; on the fly, the transcode rung q names. The stream token
   * (not the OIDC bearer) is used so the URL survives silent renews; the
   * player rebuilds only on a quality switch.
   */
  masterUrl(id: string, o: { streamToken: string; quality?: string; caps?: string }): string {
    const params = new URLSearchParams({ stream: o.streamToken });
    if (o.quality) params.set('q', o.quality);
    if (o.caps) params.set('caps', o.caps);
    return `${this.base()}/v1/items/${encodeURIComponent(id)}/play/master.m3u8?${params.toString()}`;
  }

  /** GET /v1/items/{id}/segments — intro/credits/recap segments. Wire:
   *  { item_id, segments, count }. */
  async segments(id: string): Promise<Segment[]> {
    const j = await this.getJSON<{ segments?: Segment[] }>(
      `/items/${encodeURIComponent(id)}/segments`,
    );
    return j.segments ?? [];
  }

  /** Trickplay scrub-preview VTT URL. Stream-token group, so `?stream=`. */
  trickplayVttUrl(id: string, streamToken: string): string {
    return `${this.base()}/v1/items/${encodeURIComponent(id)}/play/trickplay/thumbnails.vtt?stream=${encodeURIComponent(streamToken)}`;
  }

  /**
   * A media-asset path chino-api handed out (poster_url, backdrop_url, a
   * person's profile_url, a subtitle url) as a URL an <img> / fetch can load:
   * absolute against the configured server, with the stream token as
   * `?stream=` (the asset routes sit in the stream-token group; an <img>
   * cannot send the bearer). chino-api writes these paths origin-relative
   * ("/api/v1/..."), so they are re-rooted on the API base — see @/lib/artwork.
   */
  assetUrl(path: string | undefined, streamToken?: string): string | undefined {
    return withStreamToken(apiUrl(this.base(), path), streamToken);
  }

  /** Poster URL for an <img>: the item's poster_url, else its poster route. */
  posterUrl(item: { id: string; poster_url?: string }, streamToken?: string): string {
    const path = item.poster_url || `/api/v1/items/${encodeURIComponent(item.id)}/poster`;
    return this.assetUrl(path, streamToken) ?? '';
  }

  /** Backdrop URL for an <img>: the item's backdrop_url, else its backdrop route. */
  backdropUrl(item: { id: string; backdrop_url?: string }, streamToken?: string): string {
    const path = item.backdrop_url || `/api/v1/items/${encodeURIComponent(item.id)}/backdrop`;
    return this.assetUrl(path, streamToken) ?? '';
  }

  // ---------------------------------------------------------------------------
  // Zap (channel-surf discovery)
  // ---------------------------------------------------------------------------

  /**
   * Build a shuffled Zap candidate pool out of existing catalogue endpoints,
   * mirroring chino-web's useZapFeed: top-rated movies + newest series +
   * newest episodes, deduped against the watch history, shuffled. (The
   * server warm-pool feed at /v1/play/zap-feed is the snappier source, but it
   * lives in the stream-token group and returns a leaner shape; the resilient
   * catalogue-derived pool here is the fallback the reference client always
   * keeps and is the right primitive for a screen that just wants "give me N
   * surfable items".)
   */
  async zapFeed(limit = 30): Promise<Item[]> {
    const per = Math.max(10, limit);
    const [movies, series, episodes, watchedIds] = await Promise.all([
      this.listItems({ type: 'movie', sort: 'rating', limit: per })
        .then((r) => r.items)
        .catch(() => [] as Item[]),
      this.listItems({ type: 'series', sort: 'newest', limit: per })
        .then((r) => r.items)
        .catch(() => [] as Item[]),
      this.listItems({ type: 'episode', sort: 'newest', limit: per })
        .then((r) => r.items)
        .catch(() => [] as Item[]),
      this.getJSON<{ items?: Item[] }>(`/me/watched?limit=200`)
        .then((j) => new Set((j.items ?? []).map((it) => it.id)))
        .catch(() => new Set<string>()),
    ]);
    const byId = new Map<string, Item>();
    for (const it of [...movies, ...series, ...episodes]) {
      if (!it.id || byId.has(it.id)) continue;
      if (watchedIds.has(it.id) || it.watched_at) continue;
      byId.set(it.id, it);
    }
    const pool = shuffle(Array.from(byId.values()));
    return pool.slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Addons — UI extension slots
  // ---------------------------------------------------------------------------

  /**
   * GET /v1/extensions?slot= — what addons contribute to a named slot, from
   * portal-api's registry with the viewer's bearer forwarded. Always 200 with
   * an array, empty when no addon contributes or portal-api does not answer.
   * Returned as it came: @/lib/extensions checks every row before it shows.
   */
  async extensions(slot: string): Promise<unknown> {
    return this.getJSON<unknown>(`/extensions?slot=${encodeURIComponent(slot)}`);
  }

  // ---------------------------------------------------------------------------
  // Feedback / bug reports
  // ---------------------------------------------------------------------------

  /**
   * POST /v1/feedback — multipart bug report (report JSON part + optional
   * screenshot image part), mirroring chino-web's submitBugReport. `source`
   * is 'tv' for this client. The server dedups by fingerprint and rate-limits.
   * Returns the created/matched ticket; throws on non-2xx (manual reports
   * surface the error, auto reports swallow it at the call site).
   */
  async submitFeedback(
    report: {
      source: 'tv';
      kind: string;
      title?: string;
      description: string;
      context?: Record<string, string>;
    },
    screenshot?: Blob,
  ): Promise<FeedbackResult> {
    const form = new FormData();
    // Wrap the JSON in a Blob so the part gets an explicit application/json
    // content type — a plain string part is text/plain and the server rejects it.
    form.append('report', new Blob([JSON.stringify(report)], { type: 'application/json' }));
    if (screenshot) {
      const ext = screenshot.type === 'image/png' ? 'png' : 'jpg';
      form.append('screenshot', screenshot, `screenshot.${ext}`);
    }
    // No explicit Content-Type — fetch derives the multipart boundary from
    // the FormData body; setting it by hand would break the boundary.
    const r = await fetch(`${this.base()}/v1/feedback`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    if (!r.ok) throw new Error(`chino-api ${r.status}`);
    return (await r.json()) as FeedbackResult;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** chino-api stamps `watched_at`; the UI's convenience boolean is derived
 *  from it (non-null timestamp = watched). Done in one place so every list
 *  surface sees a consistent `watched` flag. */
function stampWatched<T extends Item>(it: T): T {
  return { ...it, watched: it.watched ?? (it.watched_at != null) };
}

interface RawWatchlist {
  id: string;
  name: string;
  isDefault?: boolean;
  itemCount?: number;
  createdAt?: string;
}

function toWatchlist(r: RawWatchlist): Watchlist {
  return { id: r.id, name: r.name, is_default: r.isDefault, count: r.itemCount };
}

/** Fisher-Yates in place — good enough for "vary the order the user sees". */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
