// Top bar above the scroll region — visual parity with chino-web's Header and
// the androidtv TvTopBar: a wide cosmetic search field on the left (ENTER
// pushes the dedicated /search screen, since D-pad typing inside a slim pill is
// impractical), then the notices bell, then the account avatar on the far
// right. The bar carries a bottom divider that meets the rail's logo-cell
// divider at the corner. Account name/initial come from useAuth().
//
// The bell is what addons told the signed-in person (@/state/notices): the
// unread counted on it, ENTER opens the Notices screen. It shows only while
// the server has notices to show — none at all without a portal-api, or on a
// server older than notices — and is its own error boundary, so a notice
// never takes the bar down. (The watchlist it used to open is the rail's.)
import { Search, Bell, User } from 'lucide-react';
import { navigate } from '@/router';
import { useFocusable } from '@/tv/focus';
import { useAuth } from '@/auth/session';
import { useNotices } from '@/state/notices';
import { badgeText, bellLabel } from '@/lib/notices';
import { QuietBoundary } from '@/components/QuietBoundary';

/** The bell's focusKey: the Notices screen hands focus back to it. */
export const NOTICES_BELL_KEY = 'notices-bell';

/** A small focusable icon cell — the bell sits in one. */
function IconCell({
  label,
  onEnter,
  focusKey,
  children,
}: {
  label: string;
  onEnter: () => void;
  focusKey?: string;
  children: React.ReactNode;
}) {
  const { ref, focused } = useFocusable({ onEnter, focusKey });
  return (
    <div
      ref={ref}
      data-focused={focused}
      title={label}
      aria-label={label}
      className={`relative flex h-9 w-9 cursor-default items-center justify-center rounded-lg transition-colors ${
        focused ? 'bg-surface-2' : ''
      }`}
    >
      {children}
    </div>
  );
}

/** The notices bell, with the unread count on it; nothing while notices
 *  are not available (or not read yet). */
function NoticesBell() {
  const list = useNotices();
  if (!list?.available) return null;
  const badge = badgeText(list.unread);
  return (
    <IconCell label={bellLabel(list.unread)} focusKey={NOTICES_BELL_KEY} onEnter={() => navigate('/notices')}>
      <Bell className="h-5 w-5 text-text" />
      {badge ? (
        <span
          aria-hidden
          className="absolute -right-2 -top-2 min-w-[1.25rem] bg-accent px-1 text-center text-xs font-bold leading-5 text-bg"
        >
          {badge}
        </span>
      ) : null}
    </IconCell>
  );
}

export function TopBar() {
  const { account } = useAuth();
  const search = useFocusable({ onEnter: () => navigate('/search') });
  const avatar = useFocusable({ onEnter: () => navigate('/settings') });

  // First initial for the avatar circle when we have an account name.
  const initial = account?.name?.trim()?.[0]?.toUpperCase();

  return (
    <div className="flex h-16 w-full shrink-0 items-center gap-6 border-b border-border-2 bg-bg px-4">
      {/* Cosmetic search field — ENTER opens /search. Capped width so it reads
          as an input, not a full-width banner (web's max-w-xl). */}
      <div
        ref={search.ref}
        data-focused={search.focused}
        className={`flex h-11 max-w-xl flex-1 cursor-default items-center gap-3 rounded-lg border bg-surface px-4 transition-colors ${
          search.focused ? 'border-accent' : 'border-border-2'
        }`}
      >
        <Search className="h-5 w-5 shrink-0 text-text" />
        <span className="truncate text-muted">Search movies, shows…</span>
      </div>

      {/* Right cluster — notices bell + account. */}
      <div className="flex items-center gap-4">
        <QuietBoundary>
          <NoticesBell />
        </QuietBoundary>

        <div
          ref={avatar.ref}
          data-focused={avatar.focused}
          title={account?.name ?? 'Account'}
          aria-label={account?.name ?? 'Account'}
          className={`flex items-center gap-3 rounded-lg px-2 py-1 transition-colors ${
            avatar.focused ? 'bg-surface-2' : ''
          }`}
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-bg">
            {initial ? (
              <span className="text-lg font-semibold">{initial}</span>
            ) : (
              <User className="h-5 w-5" />
            )}
          </div>
          {account?.name ? (
            <span className="hidden max-w-[12rem] truncate text-text md:inline">
              {account.name}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default TopBar;
