// Focusable D-pad button. Wraps useFocusable so ENTER on the remote fires
// onEnter; the focus ring is driven by data-focused (rendered by index.css's
// [data-focused="true"] rule, same as every other focusable). Variants mirror
// chino-web's button palette: primary = accent fill, secondary = surface fill,
// ghost = transparent. There is no mouse-only affordance — this is remote-first.
import type { ReactNode } from 'react';
import { useFocusable } from '@/tv/focus';

interface ButtonProps {
  children: ReactNode;
  onEnter: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Pull initial focus to this button on mount (e.g. the hero Play CTA). */
  autoFocus?: boolean;
  /** Stable key for programmatic focusKey() targeting. */
  focusKey?: string;
  disabled?: boolean;
  /** Optional leading icon (a lucide-react glyph, already sized). */
  icon?: ReactNode;
  className?: string;
}

const VARIANT: Record<NonNullable<ButtonProps['variant']>, string> = {
  // Resting + focused colours. The focus ring itself comes from data-focused;
  // these only set the fill so the focused state reads at 10ft (brighter blue
  // / lighter surface), matching the androidtv Button focusedContainerColor.
  primary: 'bg-accent text-bg data-[focused=true]:bg-[#79C0FF]',
  secondary:
    'bg-surface-2 text-text data-[focused=true]:bg-border-2',
  ghost:
    'bg-transparent text-text data-[focused=true]:bg-surface-2',
};

export function Button({
  children,
  onEnter,
  variant = 'primary',
  autoFocus,
  focusKey,
  disabled,
  icon,
  className = '',
}: ButtonProps) {
  const { ref, focused } = useFocusable({
    onEnter: disabled ? undefined : onEnter,
    autoFocus,
    focusKey,
    disabled,
  });
  return (
    <div
      ref={ref}
      data-focused={focused}
      aria-disabled={disabled}
      className={[
        'inline-flex cursor-default select-none items-center justify-center gap-2 rounded-lg px-6 py-3 text-xl font-medium transition-colors',
        VARIANT[variant],
        disabled ? 'pointer-events-none opacity-50' : '',
        className,
      ].join(' ')}
    >
      {icon ? <span className="inline-flex shrink-0">{icon}</span> : null}
      {children}
    </div>
  );
}

export default Button;
