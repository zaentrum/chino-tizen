import type {
  AppConfig,
  FeedbackResult,
  Item,
  ListResult,
  Person,
  PersonDetail,
  PlayInfo,
  Segment,
  Watchlist,
} from './types';

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
  private async getJSON<T>(path: string): Promise<T> {
    const r = await fetch(`${this.base()}/v1${path}`, { headers: this.authHeaders() });
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
   * GET /v1/people/{id}?limit= — a person + filmography. The wire shape is
   * flat ({ id, name, items }); we normalise it into { person, items } so the
   * consumer gets a Person object. 404 surfaces as a thrown error.
   */
  async getPerson(id: string, limit = 100): Promise<PersonDetail> {
    const j = await this.getJSON<{ id: string; name: string; credits?: number; items?: Item[] }>(
      `/people/${encodeURIComponent(id)}?limit=${limit}`,
    );
    return {
      person: { id: j.id, name: j.name, credits: j.credits },
      items: (j.items ?? []).map(stampWatched),
    };
  }

  // ---------------------------------------------------------------------------
  // Personal state — continue watching, watch flag, progress
  // ---------------------------------------------------------------------------

  /** GET /v1/me/continue-watching — resume rail (in-progress + next-up). */
  async continueWatching(): Promise<Item[]> {
    const j = await this.getJSON<{ items?: Item[] }>(`/me/continue-watching`);
    return (j.items ?? []).map(stampWatched);
  }

  /** POST /v1/items/{id}/progress — resume position. Called ~every 10s while
   *  watching. Body is { position_sec, duration_sec }; 204 on success. */
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
   * GET /v1/items/{id}/play/info?caps= — the server's transcode decision +
   * quality ladder. The wire ladder is [{ name, label }]; we normalise to
   * { id, label }. `qualities` is null on packaged items.
   */
  async playInfo(id: string, caps: string): Promise<PlayInfo> {
    const qs = caps ? `?caps=${encodeURIComponent(caps)}` : '';
    const j = await this.getJSON<{
      duration_ms?: number;
      mode?: string;
      default_quality?: string;
      qualities?: { name?: string; id?: string; label?: string; height?: number }[] | null;
    }>(`/items/${encodeURIComponent(id)}/play/info${qs}`);
    return {
      duration_ms: j.duration_ms ?? 0,
      mode: j.mode,
      default_quality: j.default_quality,
      qualities: (j.qualities ?? []).map((q) => ({
        id: q.id ?? q.name ?? '',
        label: q.label ?? q.name ?? '',
        height: q.height,
      })),
    };
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
   * `?stream=<token>&q=<quality>&caps=<caps>`. The server emits a single
   * video variant matching `q`. The stream token (not the OIDC bearer) is
   * used so the URL survives silent renews; the player rebuilds only on a
   * quality switch.
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
   * Poster URL for an <img>. Prefers a server-provided poster_url (relative —
   * we make it absolute against the API base and append the stream token), else
   * builds /v1/items/{id}/poster?stream=. The artwork proxy lives in the
   * stream-token group, so artwork uses `?stream=`, never the OIDC bearer.
   */
  posterUrl(item: Item, streamToken?: string): string {
    const enc = streamToken ? encodeURIComponent(streamToken) : '';
    if (item.poster_url) {
      // Already absolute (some upstream paths may be) → leave host alone;
      // otherwise resolve against the API base.
      const abs = /^https?:\/\//.test(item.poster_url)
        ? item.poster_url
        : `${this.base()}${item.poster_url.startsWith('/') ? '' : '/'}${item.poster_url}`;
      if (!enc) return abs;
      return abs.includes('?') ? `${abs}&stream=${enc}` : `${abs}?stream=${enc}`;
    }
    const base = `${this.base()}/v1/items/${encodeURIComponent(item.id)}/poster`;
    return enc ? `${base}?stream=${enc}` : base;
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
function stampWatched(it: Item): Item {
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
