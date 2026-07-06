// Self-contained focusable primitives for the onboarding screens. The shared
// @/components/Button + @/components/Spinner exist (owned by the shell agent)
// but their exact prop shapes aren't pinned in the build contract, so the
// onboarding flow — which must work before the rest of the shell mounts —
// uses these local copies to stay decoupled. Styling follows the shared design
// tokens; focus is driven by the global @/tv/focus engine via [data-focused].

import type { ReactNode } from 'react';
import { useFocusable } from '@/tv/focus';

interface FocusButtonProps {
  children: ReactNode;
  onEnter: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Stretch to fill the parent width (used for stacked recent-server rows). */
  full?: boolean;
  /** Destructive styling for "Remove" confirmations. */
  variant?: 'default' | 'danger';
}

/** A D-pad focusable button. Disabled buttons are skipped by the focus engine. */
export function FocusButton({
  children,
  onEnter,
  disabled,
  autoFocus,
  full,
  variant = 'default',
}: FocusButtonProps): JSX.Element {
  const { ref, focused } = useFocusable({
    onEnter: () => {
      if (!disabled) onEnter();
    },
    autoFocus: autoFocus && !disabled,
    disabled,
  });
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      data-focused={focused}
      className={[
        'flex h-12 items-center justify-center rounded-lg border px-6 text-lg outline-none transition-colors',
        full ? 'w-full' : '',
        disabled ? 'cursor-default opacity-50' : '',
        variant === 'danger'
          ? 'border-red bg-red/20 text-red'
          : 'border-border-2 bg-surface-2 text-text',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

/** A simple spinning ring; matches the loading affordance used elsewhere. */
export function OnboardingSpinner(): JSX.Element {
  return (
    <div
      className="h-12 w-12 animate-spin rounded-full border-4 border-border-2 border-t-accent"
      role="status"
      aria-label="Loading"
    />
  );
}
