// One funnel for bug reports on the Tizen TV client — POST /api/v1/feedback via
// the shared ChinoClient, which opens (or dedup-appends to) a ticket in the
// connected server's bug-report queue. Mirrors chino-androidtv feedback/BugReporter.kt
// + chino-web's lib/errorReporter.ts in shape and failure semantics:
//
//   - reportAuto (kind 'error' | 'crash' | 'player') is fire-and-forget and
//     swallows ALL failures — an auto report must never crash, toast, or
//     otherwise surface. Session-throttled: a fingerprint is sent at most once
//     per process, hard-capped at MAX_AUTO_PER_SESSION reports per process (the
//     server rate-limits per user on top of this).
//   - reportManual (the Settings category picker) PROPAGATES errors so the UI
//     can show an inline failure state. Not session-throttled — the server's
//     per-user rate limit is the backstop.
//
// On top of the live path there is a CRASH DRAIN: window 'error' /
// 'unhandledrejection' handlers persist a normalized record to localStorage
// (the report can't be sent if the process is dying or no server/token exists
// yet), and flushPending() drains those on the next launch once a session can
// authenticate. This is the web analogue of androidtv's FilePendingReportStore.
//
// No screenshots on TV: AVPlay renders the video plane on a hardware overlay
// that a canvas/DOM capture comes out black for, and the D-pad chrome adds
// nothing the description doesn't already say. The API still accepts one, but
// this client never sends it.

import { api } from '@/api/instance';
import { serverConfigStore } from '@/state/serverConfig';
import type { FeedbackResult } from '@/api/types';

/** Bug-report kinds. 'manual' is the Settings picker; the rest are automatic.
 *  Matches chino-web's FeedbackKind union. */
export type FeedbackKind = 'manual' | 'error' | 'crash' | 'player';

/** Hard cap on automatic reports filed in a single process. The server also
 *  rate-limits per user; this stops a render loop from hammering it locally. */
const MAX_AUTO_PER_SESSION = 3;

/** localStorage key for crash records a dying / unauthenticated process wrote
 *  on its way down; flushPending() drains it on the next healthy launch. */
const PENDING_KEY = 'chino.feedback.pending.v1';

/** Cap on persisted crash records so a crash loop can't grow the blob without
 *  bound (oldest dropped first). */
const MAX_PENDING = 10;

// ---------------------------------------------------------------------------
// Noise filter — signatures we never report (mirrors chino-web's ignore list).
// ---------------------------------------------------------------------------
//   - ResizeObserver loop…   benign browser-internal warning
//   - "Script error."        opaque cross-origin frame, zero signal
//   - AbortError             our own cancelled fetches (route changes)
//   - Failed to fetch / NetworkError   the API is unreachable — it couldn't
//     receive the report anyway
const IGNORED_MESSAGE_RE = /ResizeObserver loop|Failed to fetch|NetworkError/i;

function shouldIgnore(name: string, message: string): boolean {
  if (name === 'AbortError') return true;
  if (message.trim() === 'Script error.') return true;
  return IGNORED_MESSAGE_RE.test(message);
}

// ---------------------------------------------------------------------------
// Fingerprint — shared in spirit with chino-web / chino-androidtv (exact
// cross-platform equality is NOT required): sha256Hex(name + "|" + message with
// digits/uuids stripped + "|" + top 3 stack frames with line:column numbers and
// URL query strings stripped). Stripping the volatile parts keeps "the same
// bug" hashing to the same ticket across positions, ids and rebuilt URLs.
// ---------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

async function sha256Hex(input: string): Promise<string> {
  // crypto.subtle exists on Tizen's modern Blink/Chromium webview and in dev
  // browsers. If it's somehow missing, fall back to a cheap non-crypto hash so
  // dedup still groups identical signatures within a session.
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    let h = 0;
    for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
    return `fnv${h.toString(16)}`;
  }
}

/** Normalized error signature → sha-256 hex. */
export async function fingerprintFor(
  name: string,
  message: string,
  stack?: string,
): Promise<string> {
  const normMessage = message.replace(UUID_RE, '<uuid>').replace(/\d+/g, '<n>');
  const frames = (stack ?? '')
    .split('\n')
    .map((l) => l.trim())
    // Chrome/Blink frames start with "at "; other engines use "fn@url".
    .filter((l) => l.startsWith('at ') || l.includes('@'))
    .slice(0, 3)
    .map((l) => l.replace(/\?[^\s):]*/g, '').replace(/:\d+:\d+\)?$/, ''))
    .join('|');
  return sha256Hex(`${name}|${normMessage}|${frames}`);
}

// ---------------------------------------------------------------------------
// Device / app context — the static fields stamped onto every report. The
// analogue of androidtv's deviceStaticContext(): on TV we read what the Tizen
// web runtime exposes (and degrade gracefully off-device). Flat string map, so
// the server stores them as-is alongside the ticket.
// ---------------------------------------------------------------------------

const APP_VERSION = 'dev';

/** Server host (no scheme/path) for the ticket context — derived from the
 *  persisted ServerConfig's apiBase, same as the Settings "Server" row. */
function serverHost(): string | undefined {
  const base = serverConfigStore.get()?.apiBase;
  if (!base) return undefined;
  return base.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || undefined;
}

/** Best-effort Tizen system fields. window.tizen may be undefined off-device,
 *  and individual getters can throw, so every read is guarded. */
function tizenContext(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const sys = window.tizen?.systeminfo;
    if (sys && typeof (sys as { getCapability?: unknown }).getCapability === 'function') {
      const cap = (key: string): string | undefined => {
        try {
          return String(
            (sys as { getCapability(k: string): unknown }).getCapability(key) ?? '',
          ) || undefined;
        } catch {
          return undefined;
        }
      };
      const model = cap('http://tizen.org/system/model_name');
      const platform = cap('http://tizen.org/feature/platform.version');
      const build = cap('http://tizen.org/system/build.string');
      if (model) out.device_model = model;
      if (platform) out.tizen_version = platform;
      if (build) out.tizen_build = build;
    }
  } catch {
    /* off-device or capability lookup unsupported — context is best-effort */
  }
  return out;
}

/** The map every report carries; call sites merge their extras on top. */
function staticContext(): Record<string, string> {
  const ctx: Record<string, string> = {
    client: 'chino-tizen',
    app_version: APP_VERSION,
    route: window.location.pathname,
    user_agent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    is_tizen: String(typeof window.tizen !== 'undefined'),
  };
  const host = serverHost();
  if (host) ctx.server = host;
  return { ...ctx, ...tizenContext() };
}

// ---------------------------------------------------------------------------
// Persisted crash records (the drain). Stored as a flat array; the fingerprint
// rides in `context` so submitFeedback's typed signature (which has no
// top-level fingerprint field) carries it through and the server can still
// dedup. Corrupt blobs are treated as empty.
// ---------------------------------------------------------------------------

interface PendingRecord {
  kind: FeedbackKind;
  title?: string;
  description: string;
  /** Stamped at capture time. Folded into the submitted context.fingerprint. */
  fingerprint?: string;
  context: Record<string, string>;
}

function readPending(): PendingRecord[] {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingRecord[]) : [];
  } catch {
    return [];
  }
}

function writePending(list: PendingRecord[]): void {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-MAX_PENDING)));
  } catch {
    /* storage disabled / quota — the live path is unaffected */
  }
}

/** Append a crash record (oldest dropped past MAX_PENDING). Synchronous and
 *  swallows all failures so it is safe to call from a window 'error' handler
 *  while the process is unwinding. */
function persistPending(record: PendingRecord): void {
  try {
    writePending([...readPending(), record]);
  } catch {
    /* never let the crash handler throw */
  }
}

// ---------------------------------------------------------------------------
// BugReporter — a module singleton (the app has exactly one connected server +
// session at a time). Holds the per-session throttle state; the live + drain
// paths both flow through submit().
// ---------------------------------------------------------------------------

class BugReporter {
  /** Fingerprints already filed this session — survives route changes but not
   *  reloads (the server-side dedup catches repeats across sessions). */
  private readonly sentFingerprints = new Set<string>();
  private autoSentCount = 0;
  private flushedPending = false;
  private installed = false;

  /** Single submit funnel. Folds the fingerprint (when present) into the
   *  context so the server can dedup without a dedicated top-level field. */
  private submit(args: {
    kind: FeedbackKind;
    title?: string;
    description: string;
    fingerprint?: string;
    context?: Record<string, string>;
  }): Promise<FeedbackResult> {
    const context = { ...staticContext(), ...(args.context ?? {}) };
    if (args.fingerprint) context.fingerprint = args.fingerprint;
    return api.submitFeedback({
      source: 'tv',
      kind: args.kind,
      title: args.title,
      description: args.description,
      context,
    });
  }

  /**
   * Automatic report (error / crash / player). Fire-and-forget: every failure
   * mode (offline API, 401 pre-login, 429 rate limit, 503 unconfigured) is
   * swallowed silently. Session-deduped by fingerprint, hard-capped per process.
   * Returns the ticket on success, or null when skipped / failed.
   */
  async reportAuto(input: {
    kind: Exclude<FeedbackKind, 'manual'>;
    /** Error class/name for the fingerprint, e.g. 'TypeError'. */
    errorName: string;
    /** Raw message for the fingerprint (pre-normalization). */
    message: string;
    stack?: string;
    title?: string;
    /** Full ticket body (message + stack etc.). Defaults to "name: message". */
    description?: string;
    context?: Record<string, string>;
  }): Promise<FeedbackResult | null> {
    try {
      if (shouldIgnore(input.errorName, input.message)) return null;
      if (this.autoSentCount >= MAX_AUTO_PER_SESSION) return null;
      const fingerprint = await fingerprintFor(input.errorName, input.message, input.stack);
      if (this.sentFingerprints.has(fingerprint)) return null;
      // Reserve the slot BEFORE the network await — a render-loop error can
      // re-fire while the first submit is still in flight.
      this.sentFingerprints.add(fingerprint);
      this.autoSentCount += 1;
      return await this.submit({
        kind: input.kind,
        title: input.title ?? `${input.errorName}: ${input.message}`.slice(0, 120),
        description: input.description ?? input.stack ?? `${input.errorName}: ${input.message}`,
        fingerprint,
        context: input.context,
      });
    } catch {
      return null;
    }
  }

  /**
   * Manual report from the Settings "Report a problem" category picker. The
   * category doubles as the ticket title (no free text on TV). PROPAGATES
   * failures so the panel can show an inline error + retry. No fingerprint, so
   * a manual report never collapses into an unrelated auto-filed ticket.
   */
  reportManual(args: {
    /** Canned category — used as both title and the spine of the body. */
    category: string;
    context?: Record<string, string>;
  }): Promise<FeedbackResult> {
    return this.submit({
      kind: 'manual',
      title: args.category,
      description: `${args.category} (reported from TV settings)`,
      context: { screen: 'settings', ...(args.context ?? {}) },
    });
  }

  /**
   * Drain crash records a previous process persisted on its way down. Each is
   * submitted; on success it is removed and its fingerprint folded into the
   * session dedup (so the same signature can't also re-file via the live path).
   * On failure (e.g. 401 because the crash predated sign-in) it is KEPT for the
   * next launch. Runs at most once per process — call sites can fire it on
   * every library mount without re-walking the blob.
   */
  async flushPending(): Promise<void> {
    if (this.flushedPending) return;
    this.flushedPending = true;
    const pending = readPending();
    if (pending.length === 0) return;
    const kept: PendingRecord[] = [];
    for (const record of pending) {
      const ok = await this.submit({
        kind: record.kind,
        title: record.title,
        description: record.description,
        fingerprint: record.fingerprint,
        context: record.context,
      })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        if (record.fingerprint) this.sentFingerprints.add(record.fingerprint);
      } else {
        kept.push(record);
      }
    }
    writePending(kept);
  }

  /**
   * Install the global crash drain. Hooks window 'error' + 'unhandledrejection'
   * once. Each captured signature is persisted to localStorage (best-effort,
   * synchronous) AND attempted live via reportAuto — whichever wins, the
   * session dedup keeps it from being filed twice. Idempotent (StrictMode / HMR
   * safe). Call once from the app root, then call flushPending() once a session
   * can authenticate.
   */
  install(): void {
    if (this.installed) return;
    this.installed = true;

    window.addEventListener('error', (ev) => {
      const err = ev.error instanceof Error ? ev.error : null;
      const message =
        err?.message ?? (typeof ev.message === 'string' ? ev.message : 'Unknown error');
      const name = err?.name ?? 'Error';
      if (shouldIgnore(name, message)) return;
      const stack =
        err?.stack ??
        // Resource / non-Error events carry no stack — synthesize the source
        // location the event reports.
        `${name}: ${message}\n    at ${ev.filename || '?'}:${ev.lineno ?? 0}:${ev.colno ?? 0}`;
      void this.capture('crash', name, message, stack);
    });

    window.addEventListener('unhandledrejection', (ev) => {
      const reason: unknown = ev.reason;
      const err = reason instanceof Error ? reason : null;
      const message = err?.message ?? String(reason);
      const name = err?.name ?? 'UnhandledRejection';
      if (shouldIgnore(name, message)) return;
      void this.capture(
        'error',
        name,
        message,
        err?.stack ?? `Unhandled rejection: ${message}`,
      );
    });
  }

  /** Persist a crash record, then best-effort file it live this session. The
   *  persisted copy is the safety net for when the process dies before the
   *  live submit lands or before any server/token exists. */
  private async capture(
    kind: Exclude<FeedbackKind, 'manual'>,
    name: string,
    message: string,
    stack: string,
  ): Promise<void> {
    const fingerprint = await fingerprintFor(name, message, stack).catch(() => undefined);
    const title = `${name}: ${message}`.slice(0, 120);
    persistPending({
      kind,
      title,
      description: stack,
      fingerprint,
      context: staticContext(),
    });
    // Best-effort live submit; success removes the just-persisted record so the
    // next launch's drain doesn't re-file it.
    const sent = await this.reportAuto({
      kind,
      errorName: name,
      message,
      stack,
      title,
      description: stack,
    });
    if (sent && fingerprint) {
      writePending(readPending().filter((r) => r.fingerprint !== fingerprint));
    }
  }
}

/** The app-wide bug reporter. Screens import this directly. */
export const bugReporter = new BugReporter();

/**
 * Canned bug-report categories for the Settings "Report a problem" picker.
 * D-pad-only, so the manual path offers a pick-one list instead of free text.
 * The category doubles as the ticket title; "Something else" exists so nothing
 * is unreportable. Order + wording mirror chino-androidtv's REPORT_CATEGORIES.
 */
export const REPORT_CATEGORIES: readonly string[] = [
  "Playback won't start",
  'Video stutters or freezes',
  'Audio out of sync',
  'Subtitles wrong or missing',
  'App is slow',
  'Something else',
];

/**
 * Map a submit failure to a plain-language line for the manual panel — same
 * three buckets androidtv shows (429 rate limit / 503 reporting unconfigured /
 * everything else → connection wording). The ChinoClient throws
 * `Error('chino-api <status>')`, so we parse the status out of the message.
 */
export function describeReportError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b429\b/.test(msg)) return 'Too many reports right now — try again in a few minutes.';
  if (/\b503\b/.test(msg)) return "Bug reporting isn't set up on this server.";
  return "Couldn't send the report. Check your connection and try again.";
}
