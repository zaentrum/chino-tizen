// The signed-in person's notices — what addons told them — for every screen
// at once: the top bar's bell counts the unread, the Notices screen lists
// them. One copy, asked for again every minute while the app is shown and
// when it is shown again, as the portal's bell does, and only while someone
// is signed in: useNoticesPolling runs with the signed-in app, keyed by the
// account, so the next account never sees the last one's notices.
//
// Best effort throughout. A poll that does not get through keeps what is
// shown; available false shows nothing; nothing here throws into a screen,
// and no call is left to reject unhandled (the crash drain would file it).
// A change — read, read all, delete — shows at once and is sent; one
// chino-api does not make reads the list again, which shows the notice as
// it is. An answer to a poll sent before a change is not taken: it would
// undo the change on screen until the next one.

import { useEffect, useState } from 'react';
import { api } from '@/api/instance';
import { authStore } from '@/auth/session';
import { NOTICE_POLL_MS, markAllRead, markRead, removeNotice, type NoticeList } from '@/lib/notices';

/** The list shown; null until the first answer for this account. */
let current: NoticeList | null = null;
/** Bumped whenever the account changes: answers for the last one are dropped. */
let account = 0;
/** Bumped by every change made here: an answer to a poll sent before is stale. */
let changes = 0;
const listeners = new Set<() => void>();

function set(next: NoticeList | null): void {
  current = next;
  for (const l of listeners) l();
}

/** Ask chino-api again. Never rejects. The token is topped up first: the ask
 *  as the app is shown again often follows a night's sleep, and the first one
 *  goes out before the session's own first refresh. */
async function refresh(): Promise<void> {
  const asked = { account, changes };
  try {
    await authStore.ensureFreshToken();
    const next = await api.notices();
    if (asked.account === account && asked.changes === changes) set(next);
  } catch {
    /* no answer: keep what is shown */
  }
}

/** A notice opened: read, unless it was already. */
function read(id: string): void {
  const n = current?.notices.find((x) => x.id === id);
  if (!current || !n || n.readAt !== null) return;
  changes++;
  set(markRead(current, id, new Date().toISOString()));
  void api.readNotice(id).catch(() => refresh());
}

/** Every notice read. */
function readAll(): void {
  if (!current || current.unread === 0) return;
  changes++;
  set(markAllRead(current, new Date().toISOString()));
  void api.readAllNotices().catch(() => refresh());
}

/** A notice deleted. */
function remove(id: string): void {
  if (!current || !current.notices.some((x) => x.id === id)) return;
  changes++;
  set(removeNotice(current, id));
  void api.deleteNotice(id).catch(() => refresh());
}

export const noticesStore = {
  get: (): NoticeList | null => current,
  refresh,
  read,
  readAll,
  remove,
};

/** The notices as shown, live: null until the first answer. */
export function useNotices(): NoticeList | null {
  const [snapshot, setSnapshot] = useState<NoticeList | null>(current);
  useEffect(() => {
    const sub = () => setSnapshot(current);
    listeners.add(sub);
    // Reconcile in case the store changed between render and effect commit.
    sub();
    return () => {
      listeners.delete(sub);
    };
  }, []);
  return snapshot;
}

/**
 * Keeps the notices of the signed-in account `sub` current: asks now, every
 * NOTICE_POLL_MS while the document is shown, and when it is shown again (a
 * Tizen app is hidden and shown as its document is). Mounted with the
 * signed-in app; when it unmounts — signed out — or the account changes, the
 * last account's list goes with it.
 */
export function useNoticesPolling(sub: string | null): void {
  useEffect(() => {
    account++;
    set(null);
    if (!sub) return;
    void refresh();
    const shown = (): boolean => document.visibilityState !== 'hidden';
    const timer = window.setInterval(() => {
      if (shown()) void refresh();
    }, NOTICE_POLL_MS);
    const onShow = (): void => {
      if (shown()) void refresh();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
      account++;
      set(null);
    };
  }, [sub]);
}
