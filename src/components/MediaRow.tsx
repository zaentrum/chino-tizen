// Horizontal shelf of poster cards. The home / browse / search / watchlist
// shelf primitive, mirroring chino-web's MediaRow + the androidtv LazyRow
// shelves. On TV there's no scrollbar or hover chevron: the @/tv/focus engine
// moves focus LEFT/RIGHT between cards and calls scrollIntoView on the focused
// card, so the row only has to (a) print the section title and (b) lay the
// cards out in a single horizontally-overflowing flex track. overflow-x is
// hidden (not auto) because focus-driven scrollIntoView does the scrolling —
// a visible scrollbar would just be 10-foot clutter.
import type { Item } from '@/api/types';
import { FocusableCard } from './FocusableCard';

interface MediaRowProps {
  title: string;
  items: Item[];
  onSelect: (item: Item) => void;
  /** Stream token threaded to each card's poster URL. */
  streamToken?: string;
  /** autoFocus the first card of this row (one row per screen should set it). */
  autoFocusFirst?: boolean;
  /** Prefix for per-card focusKey so screens can target cards programmatically. */
  focusKeyPrefix?: string;
}

export function MediaRow({
  title,
  items,
  onSelect,
  streamToken,
  autoFocusFirst = false,
  focusKeyPrefix,
}: MediaRowProps) {
  // Empty shelves collapse entirely — same as web's `if (items.length === 0)
  // return null`, so a zeroed filter / missing rail doesn't leave a bare title.
  if (items.length === 0) return null;
  return (
    <div className="mb-8">
      <h2 className="mb-4 text-2xl font-semibold text-text">{title}</h2>
      {/* gap-4 + py-3 give the focused card's scale-105 room to grow without
          clipping; overflow-x-hidden because the focus engine scrolls. */}
      <div className="flex gap-4 overflow-x-hidden py-3">
        {items.map((item, i) => (
          <FocusableCard
            key={item.id}
            item={item}
            streamToken={streamToken}
            autoFocus={autoFocusFirst && i === 0}
            focusKey={focusKeyPrefix ? `${focusKeyPrefix}:${item.id}` : undefined}
            onEnter={() => onSelect(item)}
          />
        ))}
      </div>
    </div>
  );
}

export default MediaRow;
