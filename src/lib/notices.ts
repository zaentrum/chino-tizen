// Notices: what addons tell the signed-in person — "your title is ready" —
// kept by portal-api, which shows each person their own and nobody else's,
// and read through chino-api with the viewer's bearer: GET /api/v1/notices,
// POST …/{noticeId}/read, POST …/read-all, DELETE …/{noticeId}. Ported from
// the portal's bell (zaentrum-portal src/lib/notices.ts) for a TV:
//
//   - what a notice says is the addon's plain text, shown as text and never
//     as markup, a body's line breaks kept; what portal-api refuses in it is
//     checked again here, where the text shows;
//   - a TV cannot show a web page, so a notice's link is never followed —
//     its text stands alone — and an itemId opens the detail screen, whose
//     item routes hold a capped viewer to their cap;
//   - available false (chino-api had no portal-api to ask) is nothing to
//     show, not an error.
//
// Pure: notices.test.ts runs it under node --test.

// ─── the documents (mirror chino-api's portal.Notice) ───────────────────────

export interface Notice {
  id: string;
  /** The key of the addon it is from. */
  addon: string;
  /** The addon's app, as the registry has it: whom the notice is from. */
  addonTitle: string;
  addonIcon: string;
  /** One line. */
  title: string;
  /** Line breaks allowed. */
  body: string;
  /** Where the notice leads on the web, '' for none: not followed on a TV. */
  link: string;
  /** The catalog item it is about, '' for none. */
  itemId: string;
  /** RFC 3339, UTC. */
  createdAt: string;
  /** null while unread. */
  readAt: string | null;
}

export interface NoticeList {
  /** Newest first. */
  notices: Notice[];
  unread: number;
  /** false when no portal-api answered: the list is empty then, and says
   *  nothing about the person's notices. */
  available: boolean;
}

/** How often the app asks again while it is shown — the portal's bell's
 *  minute. */
export const NOTICE_POLL_MS = 60_000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// What portal-api refuses in a notice's text: control characters (but, in a
// body, line breaks) and the formatting characters that turn text around.
const NOT_PLAIN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** A title or body as it may show: without what portal-api refuses (a tab
 *  is a space), "\r\n" a line break; a title on one line. */
export function plainText(raw: string, lines: boolean): string {
  const text = raw.replace(/\r\n?/g, '\n').replace(NOT_PLAIN, (c) => (c === '\t' ? ' ' : ''));
  return (lines ? text : text.replace(/\n+/g, ' ')).trim();
}

/** noticeListOf reads GET /api/v1/notices as it came: unless available,
 *  there is nothing to show; what is no notice — no id, no title, an id
 *  listed already — is left out; the unread count is never below the unread
 *  notices listed. */
export function noticeListOf(raw: unknown): NoticeList {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as {
    notices?: unknown;
    unread?: unknown;
    available?: unknown;
  };
  if (doc.available !== true) return { notices: [], unread: 0, available: false };
  const notices: Notice[] = [];
  const seen = new Set<string>();
  if (Array.isArray(doc.notices)) {
    for (const n of doc.notices as Record<string, unknown>[]) {
      if (!n || typeof n !== 'object') continue;
      const id = str(n.id);
      const title = plainText(str(n.title), false);
      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      notices.push({
        id,
        addon: str(n.addon),
        addonTitle: str(n.addonTitle),
        addonIcon: str(n.addonIcon),
        title,
        body: plainText(str(n.body), true),
        link: str(n.link),
        itemId: str(n.itemId),
        createdAt: str(n.createdAt),
        readAt: typeof n.readAt === 'string' && n.readAt ? n.readAt : null,
      });
    }
  }
  const listed = notices.filter((n) => n.readAt === null).length;
  const unread =
    typeof doc.unread === 'number' && Number.isInteger(doc.unread) && doc.unread >= 0 ? doc.unread : listed;
  return { notices, unread: Math.max(unread, listed), available: true };
}

// ─── reading ─────────────────────────────────────────────────────────────────

/** The unread count on the bell: nothing at none, 99+ past 99. */
export function badgeText(unread: number): string {
  if (!(unread > 0)) return '';
  return unread > 99 ? '99+' : String(Math.floor(unread));
}

/** What the bell is called to a screen reader. */
export function bellLabel(unread: number): string {
  return unread > 0 ? `Notices, ${unread} unread` : 'Notices';
}

/** Whom a notice is from: its addon's title, else its key. */
export function fromText(n: Pick<Notice, 'addon' | 'addonTitle'>): string {
  return n.addonTitle.trim() || n.addon || 'An addon';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Spelled out rather than asked of the TV's Intl, whose month names vary by
// model and firmware.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** When a notice came, short: now, 5m, 3h, 2d — and from a week on the
 *  date, "12 Sep", with the year when it is not this one. */
export function ageText(createdAt: string, now: number): string {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return '';
  const ago = now - t;
  if (ago < MINUTE) return 'now';
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)}m`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h`;
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)}d`;
  const d = new Date(t);
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

// What an itemId may be, as portal-api keeps it: letters, digits and
// . _ : -, at most 128.
const ITEM_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The detail screen a notice opens — its itemId's — or null when it is
 *  about no title. */
export function noticeItemRoute(n: Pick<Notice, 'itemId'>): string | null {
  const id = n.itemId.trim();
  return ITEM_ID.test(id) ? `/detail/${encodeURIComponent(id)}` : null;
}

// ─── changing ────────────────────────────────────────────────────────────────

/** The list once a notice is read, before chino-api answers. */
export function markRead(list: NoticeList, id: string, at: string): NoticeList {
  let changed = 0;
  const notices = list.notices.map((n) => {
    if (n.id !== id || n.readAt !== null) return n;
    changed++;
    return { ...n, readAt: at };
  });
  return { ...list, notices, unread: Math.max(0, list.unread - changed) };
}

/** The list once every notice is read. */
export function markAllRead(list: NoticeList, at: string): NoticeList {
  return {
    ...list,
    notices: list.notices.map((n) => (n.readAt === null ? { ...n, readAt: at } : n)),
    unread: 0,
  };
}

/** The list without a notice. */
export function removeNotice(list: NoticeList, id: string): NoticeList {
  const gone = list.notices.find((n) => n.id === id);
  return {
    ...list,
    notices: list.notices.filter((n) => n.id !== id),
    unread: Math.max(0, list.unread - (gone && gone.readAt === null ? 1 : 0)),
  };
}

/** The notice focus moves to once `id` is deleted: the one after it, else
 *  the one before, else none. */
export function focusAfterRemoval(list: NoticeList, id: string): string | null {
  const i = list.notices.findIndex((n) => n.id === id);
  if (i < 0) return null;
  return list.notices[i + 1]?.id ?? list.notices[i - 1]?.id ?? null;
}
