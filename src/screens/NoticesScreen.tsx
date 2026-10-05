// Notices — what addons told the signed-in person ("your title is ready"),
// newest first. Reached from the top bar's bell, which counts the unread; the
// list is the shared one (@/state/notices), asked for again on entry. The
// portal's bell (zaentrum-portal src/shell/NoticesBell.tsx) on a 10-foot
// screen:
//
//   ┌──────┬───────────────────────────────────────────────────────┐
//   │ Side │ TopBar (search · notices · account)                    │
//   │ Rail ├───────────────────────────────────────────────────────┤
//   │      │ Notices                                [Mark All Read] │
//   │      │ ▌Example · 5m                                [Delete]  │
//   │      │ ▌Your title is ready                                   │
//   │      │ ▌It is in your library now.                            │
//   │      │ ▌Open                                                  │
//   └──────┴───────────────────────────────────────────────────────┘
//
// Each notice shows whom it is from and when, its title and its body: the
// addon's plain text, the body's line breaks kept (@/lib/notices). A TV
// cannot show a web page, so a notice's link is not followed — its text
// stands alone. An unread one carries the accent bar.
//
// Focus lands on the newest. UP/DOWN walk the list, RIGHT reaches a notice's
// Delete. ENTER opens a notice: it is read, and one about a title opens that
// title's detail screen ("Open" says so). Mark All Read shows while any is
// unread. After a delete focus moves to the next notice's Delete, else the
// one before, else the bell — a run of deletes is a run of ENTERs. BACK pops
// the route.

import { useEffect, useRef, useState } from 'react';
import { CheckCheck, ChevronRight, Trash2 } from 'lucide-react';
import { SideRail } from '@/components/SideRail';
import { TopBar, NOTICES_BELL_KEY } from '@/components/TopBar';
import { Spinner } from '@/components/Spinner';
import { focusKey, useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { back, navigate } from '@/router';
import { noticesStore, useNotices } from '@/state/notices';
import {
  ageText,
  focusAfterRemoval,
  fromText,
  noticeItemRoute,
  type Notice,
} from '@/lib/notices';

const rowKey = (id: string): string => `notice:${id}`;
const deleteKey = (id: string): string => `notice-delete:${id}`;

export default function NoticesScreen(): JSX.Element {
  const list = useNotices();
  // The entry's own ask has answered (or not got through): until then, a
  // list not read yet is loading; after, it is nothing to show.
  const [asked, setAsked] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useRemoteKey(TVKey.BACK, () => back());

  // Ask again on entry — the bell's count may be a minute old — and keep the
  // ages current while the screen is open.
  useEffect(() => {
    let alive = true;
    void noticesStore.refresh().then(() => {
      if (alive) setAsked(true);
    });
    const tick = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      alive = false;
      window.clearInterval(tick);
    };
  }, []);
  useEffect(() => {
    setNow(Date.now());
  }, [list]);

  // The notice focus lands on: the newest, when the screen first has a list
  // to show — and only then. One that arrives later, or comes back (a delete
  // chino-api did not make), takes no focus.
  const landing = useRef<string | null | undefined>(undefined);
  if (landing.current === undefined && list) landing.current = list.notices[0]?.id ?? null;
  const landOn = landing.current;
  useEffect(() => {
    if (landing.current) landing.current = null;
  });

  const open = (n: Notice): void => {
    noticesStore.read(n.id);
    const route = noticeItemRoute(n);
    if (route) navigate(route);
  };

  const remove = (n: Notice): void => {
    if (!list) return;
    // Focus moves first, while the notice that takes it is where it was.
    const next = focusAfterRemoval(list, n.id);
    focusKey(next ? deleteKey(next) : NOTICES_BELL_KEY);
    noticesStore.remove(n.id);
  };

  const readAll = (): void => {
    // The button goes once nothing is unread: focus moves to the newest.
    const first = list?.notices[0];
    if (first) focusKey(rowKey(first.id));
    noticesStore.readAll();
  };

  return (
    <div className="flex h-screen w-full bg-bg text-text">
      <SideRail active="notices" />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 overflow-y-auto px-10 py-6">
          <div className="flex max-w-6xl flex-col">
            {/* As tall with Mark All Read as without: the list stays put when it goes. */}
            <div className="mb-6 flex min-h-[3.1rem] items-center justify-between">
              <h1 className="text-3xl font-bold text-text">Notices</h1>
              {list && list.unread > 0 ? <ReadAllButton onEnter={readAll} /> : null}
            </div>

            {list === null ? (
              asked ? null : <Spinner label="Loading notices…" fullscreen={false} />
            ) : !list.available ? null : list.notices.length === 0 ? (
              <p className="mt-8 text-muted">No notices. An addon you use can tell you something here.</p>
            ) : (
              <ul className="flex flex-col gap-4">
                {list.notices.map((n) => (
                  <NoticeRow
                    key={n.id}
                    notice={n}
                    now={now}
                    autoFocus={n.id === landOn}
                    onOpen={() => open(n)}
                    onDelete={() => remove(n)}
                  />
                ))}
              </ul>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/** One notice: a focusable card — whom from · when, the title, the body —
 *  and its Delete to the right. */
function NoticeRow({
  notice,
  now,
  autoFocus,
  onOpen,
  onDelete,
}: {
  notice: Notice;
  now: number;
  autoFocus: boolean;
  onOpen: () => void;
  onDelete: () => void;
}): JSX.Element {
  const row = useFocusable({ onEnter: onOpen, autoFocus, focusKey: rowKey(notice.id) });
  const del = useFocusable({ onEnter: onDelete, focusKey: deleteKey(notice.id) });
  const unread = notice.readAt === null;
  const age = ageText(notice.createdAt, now);
  return (
    <li className="flex items-start gap-4">
      <div
        ref={row.ref}
        data-focused={row.focused}
        className={`flex min-w-0 flex-1 cursor-default select-none flex-col gap-1 border-l-4 px-5 py-4 transition-colors ${
          unread ? 'border-accent' : 'border-transparent'
        } ${row.focused ? 'bg-surface-2' : 'bg-surface'}`}
      >
        <div className="flex items-center gap-2 text-base text-muted">
          <span className="truncate">{fromText(notice)}</span>
          {age ? <span className="shrink-0">· {age}</span> : null}
        </div>
        <p className={`break-words text-xl ${unread ? 'font-semibold text-fg' : 'text-text'}`}>
          {notice.title}
        </p>
        {notice.body ? (
          <p className="whitespace-pre-line break-words text-lg text-muted">{notice.body}</p>
        ) : null}
        {noticeItemRoute(notice) ? (
          <span className="mt-1 inline-flex items-center gap-1 text-base text-accent">
            Open
            <ChevronRight className="h-4 w-4" />
          </span>
        ) : null}
      </div>
      <div
        ref={del.ref}
        data-focused={del.focused}
        aria-label={`Delete notice: ${notice.title}`}
        className={`inline-flex shrink-0 cursor-default select-none items-center gap-2 rounded-full px-4 py-2 text-base text-red transition-colors ${
          del.focused ? 'bg-surface-2' : 'bg-surface'
        }`}
      >
        <Trash2 className="h-5 w-5" />
        <span>Delete</span>
      </div>
    </li>
  );
}

/** Mark All Read, in the header while any notice is unread. */
function ReadAllButton({ onEnter }: { onEnter: () => void }): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={`inline-flex cursor-default select-none items-center gap-2 rounded-full border px-5 py-2.5 text-lg transition-colors ${
        focused ? 'border-accent bg-surface-2 text-accent' : 'border-border-2 bg-surface text-text'
      }`}
    >
      <CheckCheck className="h-5 w-5" />
      Mark All Read
    </div>
  );
}
