// Left navigation rail — the persistent spine of every non-player screen.
// Layout mirrors chino-androidtv's TvSideRail (and chino-web's Sidebar): the
// `>c` brand mark up top, House / Film / Tv / Bookmark / Zap stacked in the
// middle, Settings pinned at the bottom. Each item is a focusable icon cell;
// ENTER navigates via @/router. The active route's cell carries the surface
// fill + accent glyph so the user always knows where they are; D-pad focus
// adds the ring (data-focused) on top.
import {
  House,
  Film,
  Tv,
  Bookmark,
  Zap,
  Settings as SettingsIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { navigate } from '@/router';
import type { RouteMatch } from '@/router';
import { useFocusable } from '@/tv/focus';

interface SideRailProps {
  /** The matched route name, so the rail can highlight the active cell. */
  active: RouteMatch['name'];
  /** Optional active browse type (movie | series) so Movies vs Series light up
   *  correctly when active === 'browse'. */
  activeType?: string;
}

interface RailItemProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  to: string;
}

function RailItem({ icon: Icon, label, active, to }: RailItemProps) {
  const { ref, focused } = useFocusable({ onEnter: () => navigate(to) });
  return (
    <div
      ref={ref}
      data-focused={focused}
      title={label}
      aria-label={label}
      className={`flex h-12 w-12 cursor-default items-center justify-center rounded-lg transition-colors ${
        active ? 'bg-surface' : ''
      } ${focused ? 'bg-surface-2' : ''}`}
    >
      <Icon
        className={`h-6 w-6 ${active || focused ? 'text-accent' : 'text-muted'}`}
      />
    </div>
  );
}

export function SideRail({ active, activeType }: SideRailProps) {
  return (
    <nav className="flex h-screen w-20 shrink-0 flex-col border-r border-border-2 bg-bg">
      {/* Logo cell — 64px tall with its own bottom divider, forming the L with
          the top bar's bottom divider. */}
      <div className="flex h-16 items-center justify-center border-b border-border-2">
        <span className="text-2xl font-bold text-accent">&gt;c</span>
      </div>

      {/* Primary nav — stacked, centred. */}
      <div className="flex flex-1 flex-col items-center gap-2 px-4 pt-4">
        <RailItem icon={House} label="Home" active={active === 'home'} to="/" />
        <RailItem
          icon={Film}
          label="Movies"
          active={active === 'browse' && activeType === 'movie'}
          to="/browse/movie"
        />
        <RailItem
          icon={Tv}
          label="Series"
          active={active === 'browse' && activeType === 'series'}
          to="/browse/series"
        />
        <RailItem
          icon={Bookmark}
          label="Watchlist"
          active={active === 'watchlist'}
          to="/watchlist"
        />
        <RailItem icon={Zap} label="Zap" active={active === 'zap'} to="/zap" />
      </div>

      {/* Settings pinned at the bottom. */}
      <div className="flex items-center justify-center p-4">
        <RailItem
          icon={SettingsIcon}
          label="Settings"
          active={active === 'settings'}
          to="/settings"
        />
      </div>
    </nav>
  );
}

export default SideRail;
