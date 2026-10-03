// 2:3 poster card, D-pad focusable. The catalogue's primary tile — used by
// MediaRow on every browse / home / search / watchlist shelf. Layout mirrors
// chino-web's MediaCard (title + year·rating BELOW the artwork, not overlaid)
// and the androidtv PosterCard: a 2:3 poster, a watched ✓ badge top-right, a
// thin accent progress bar across the poster bottom for in-progress items, and
// an episode "SxxExx · title" meta line for episodes. Focus scales the card up
// slightly and renders the ring via data-focused.
import { Check, Image as ImageIcon } from 'lucide-react';
import type { ContinueWatchingItem, Item } from '@/api/types';
import { api } from '@/api/instance';
import { useFocusable } from '@/tv/focus';

interface FocusableCardProps {
  /** A catalogue item, or a continue-watching row (which carries a position). */
  item: Item | ContinueWatchingItem;
  onEnter: () => void;
  /** Optional stream token so the poster URL is authorised (api.posterUrl). */
  streamToken?: string;
  autoFocus?: boolean;
  focusKey?: string;
  /** Notify the parent shelf when this card takes focus (rail can scroll it). */
  onFocus?: () => void;
}

/** A continue-watching row's position as 0..100 percent, or null when nothing
 *  is in progress (a plain item, or a Next Up card). The row's duration_sec is
 *  the timeline the player reported (chino-web divides by it too); the
 *  catalogue runtime stands in when it never reported one. */
function progressPct(item: Item | ContinueWatchingItem): number | null {
  if (!('position_sec' in item) || item.up_next) return null;
  const pos = item.position_sec;
  if (!(pos > 0)) return null;
  const durSec =
    item.duration_sec > 0 ? item.duration_sec : item.duration_ms ? item.duration_ms / 1000 : 0;
  if (durSec <= 0) return null;
  return Math.min(100, Math.max(0, (pos / durSec) * 100));
}

export function FocusableCard({
  item,
  onEnter,
  streamToken,
  autoFocus,
  focusKey,
  onFocus,
}: FocusableCardProps) {
  const { ref, focused } = useFocusable({ onEnter, autoFocus, focusKey, onFocus });
  const poster = api.posterUrl(item, streamToken);
  const pct = progressPct(item);
  const isEpisode = item.type === 'episode';
  const ratingLabel =
    item.rating != null ? item.rating.toFixed(1) : undefined;

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
          <img
            src={poster}
            alt={item.title}
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-border-2">
            <ImageIcon className="h-8 w-8" />
          </div>
        )}

        {/* Watched badge — top-right green pill, matches web's emerald corner
            check + the androidtv PosterCard ✓. */}
        {item.watched ? (
          <div
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-signal-green shadow-lg"
            title="Watched"
          >
            <Check className="h-4 w-4 stroke-[3] text-white" />
          </div>
        ) : null}

        {/* In-progress bar — thin accent fill across the poster bottom. */}
        {pct != null ? (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-border-2">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
      </div>

      <div className="p-3">
        <h3 className="truncate font-medium text-text">{item.title}</h3>
        {isEpisode &&
        item.season_number != null &&
        item.episode_number != null ? (
          <div className="mt-1 flex items-center gap-2 truncate text-sm text-muted">
            <span className="shrink-0 text-accent">
              S{String(item.season_number).padStart(2, '0')}E
              {String(item.episode_number).padStart(2, '0')}
            </span>
          </div>
        ) : (
          <div className="mt-1 flex items-center gap-2 text-sm text-muted">
            {item.year ? <span>{item.year}</span> : null}
            {ratingLabel ? (
              <>
                {item.year ? <span>•</span> : null}
                <span className="text-accent">{ratingLabel}</span>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export default FocusableCard;
