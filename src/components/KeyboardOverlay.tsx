// On-screen QWERTY keyboard for D-pad-only text entry (server URL on
// Add-Server, query text on Search). Every key is a registered focusable so
// the global spatial-navigation focus engine (@/tv/focus) moves between keys
// with the arrow pad; ENTER on a key types it. Mirrors the keyboard
// affordances of chino-androidtv's ServerSetupScreen / SearchScreen, which
// lean on the platform IME — Tizen has no system IME for a web app, so we
// draw our own.

import { useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { Delete, CornerDownLeft, Space } from 'lucide-react';

interface KeyboardOverlayProps {
  /** Current text value (controlled). */
  value: string;
  /** Fired on every edit (key press, backspace, space). */
  onChange: (next: string) => void;
  /** Fired when the user activates the "Done"/Go key. */
  onSubmit: () => void;
  /** Fired on BACK / Close — dismiss without submitting. */
  onClose: () => void;
  /** Optional heading shown above the value preview. */
  title?: string;
  /** Optional placeholder shown when value is empty. */
  placeholder?: string;
}

// Four rows of keys. The trailing control row carries space / backspace / done.
const ROWS: string[][] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '@'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '-', '/'],
  [':', '_', '~', '?', '#', '&', '=', '%', '+', '*'],
];

/**
 * Full-screen modal QWERTY. The value preview is fixed at the top; the key
 * grid fills the rest. Submitting / closing is the host's responsibility (this
 * component only edits `value` and signals intent). BACK closes.
 */
export default function KeyboardOverlay({
  value,
  onChange,
  onSubmit,
  onClose,
  title,
  placeholder,
}: KeyboardOverlayProps): JSX.Element {
  useRemoteKey(TVKey.BACK, () => onClose());

  const typeChar = (c: string): void => onChange(value + c);
  const backspace = (): void => onChange(value.slice(0, -1));
  const space = (): void => onChange(`${value} `);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 bg-bg/95 px-16 py-12">
      {title ? <h2 className="text-2xl font-semibold text-text">{title}</h2> : null}

      {/* Value preview — large, room-readable, with a blinking-free caret bar. */}
      <div className="flex min-h-[3.5rem] w-full max-w-3xl items-center rounded-lg border-2 border-border-2 bg-surface px-5 py-3">
        {value ? (
          <span className="break-all text-2xl text-text">{value}</span>
        ) : (
          <span className="text-2xl text-muted">{placeholder ?? ''}</span>
        )}
        <span className="ml-1 h-7 w-[2px] bg-accent" aria-hidden />
      </div>

      {/* Key grid. Each cell is its own focusable. */}
      <div className="flex flex-col gap-3">
        {ROWS.map((row, rowIdx) => (
          <div key={rowIdx} className="flex gap-3">
            {row.map((c) => (
              <KeyButton
                key={c}
                label={c}
                onEnter={() => typeChar(c)}
                autoFocus={rowIdx === 0 && c === '1'}
              />
            ))}
          </div>
        ))}

        {/* Control row: space, backspace, done. */}
        <div className="mt-2 flex gap-3">
          <KeyButton label="space" wide icon={<Space size={26} />} onEnter={space} />
          <KeyButton label="delete" wide icon={<Delete size={26} />} onEnter={backspace} />
          <KeyButton
            label="done"
            wide
            primary
            icon={<CornerDownLeft size={26} />}
            onEnter={onSubmit}
          />
        </div>
      </div>
    </div>
  );
}

interface KeyButtonProps {
  label: string;
  onEnter: () => void;
  icon?: JSX.Element;
  wide?: boolean;
  primary?: boolean;
  autoFocus?: boolean;
}

function KeyButton({ label, onEnter, icon, wide, primary, autoFocus }: KeyButtonProps): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus });
  return (
    <button
      ref={ref}
      type="button"
      data-focused={focused}
      // Single-char keys are square; control keys span wider. The focus ring
      // is driven by [data-focused] per the design-token CSS, so we only set
      // the resting surface/border here.
      className={[
        'flex items-center justify-center rounded-md border text-xl outline-none transition-colors',
        wide ? 'h-14 w-32' : 'h-14 w-14',
        primary
          ? 'border-accent bg-accent/20 text-accent'
          : 'border-border-2 bg-surface-2 text-text',
      ].join(' ')}
    >
      {icon ?? label}
    </button>
  );
}
