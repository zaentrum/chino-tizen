// A catalogue person's picture: their portrait when the catalog has one,
// otherwise a box with their initials (chino-web's PersonAvatar). The portrait
// is an <img> laid over the initials, so they show while it loads and take
// over if it fails — chino-api answers 404 for a person without a portrait.
// Used by the person screen's header and the search "Cast & crew" chips.

import { useState } from 'react';

interface PersonAvatarProps {
  /** Drives the initials and the alt text. */
  name: string;
  /** The portrait URL (profile_url resolved, with the stream token). */
  src?: string;
  /** Width in pixels. */
  size?: number;
  /** A 2:3 portrait frame (the person page) instead of a square. */
  portrait?: boolean;
  className?: string;
}

/** First letter of the first two words, uppercased; '?' when there are none. */
export function initialsOf(name: string): string {
  return (
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

export function PersonAvatar({
  name,
  src,
  size = 48,
  portrait = false,
  className = '',
}: PersonAvatarProps): JSX.Element {
  // Which src failed, rather than a flag: a new src (the stream token
  // arriving, another person) gets a fresh attempt.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showPhoto = !!src && src !== failedSrc;
  const height = portrait ? Math.round(size * 1.5) : size;
  return (
    <div
      className={`relative flex shrink-0 select-none items-center justify-center overflow-hidden bg-surface-2 font-semibold text-accent ${className}`}
      style={{ width: `${size}px`, height: `${height}px`, fontSize: `${Math.max(14, Math.round(size * 0.36))}px` }}
      title={name}
    >
      <span aria-hidden={showPhoto ? true : undefined}>{initialsOf(name)}</span>
      {showPhoto ? (
        <img
          src={src}
          alt={name}
          // Faces sit in the upper part of a portrait: keep them in a square crop.
          className="absolute inset-0 h-full w-full object-cover"
          style={{ objectPosition: '50% 20%' }}
          decoding="async"
          onError={() => setFailedSrc(src ?? null)}
        />
      ) : null}
    </div>
  );
}

export default PersonAvatar;
