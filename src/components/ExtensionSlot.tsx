// An addon slot drawn as the TV's own buttons — chino-web's ExtensionSlot on a
// 10-foot screen. The rows come from chino-api (GET /api/v1/extensions, the
// portal's registry behind it), and only those @/lib/extensions lets through
// show up, held to the configured server's origin: a slot no addon fills,
// portal-api not answering, rows that point anywhere they may not — all show
// nothing, so the core never knows which addons there are. Every button is a
// @/tv/focus focusable, left to right in the slot's order:
//
//   action  ENTER POSTs, with the viewer's bearer, one at a time (a remote
//           can deliver one OK twice); a line under the buttons says whether
//           it was sent
//   link    a TV has no browser to open it in, so ENTER shows its address
//           under the buttons, to open on a phone or computer; BACK hides it
//
// The buttons never take focus by themselves: the slot can show up while the
// on-screen keyboard is still open, and an ENTER meant for a key must not send
// an action. The slot is its own error boundary.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes,
  Clapperboard,
  Database,
  FileText,
  Gauge,
  Globe,
  Image,
  LayoutGrid,
  Library,
  ListVideo,
  Music,
  Puzzle,
  Radar,
  Server,
  Settings,
  Tv,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/api/instance';
import { authStore } from '@/auth/session';
import { Button } from '@/components/Button';
import { QuietBoundary } from '@/components/QuietBoundary';
import { useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import {
  sendSlotAction,
  serverOrigin,
  slotButtons,
  type SlotButton,
  type SlotIconName,
} from '@/lib/extensions';

// The palette, glyph by glyph (@/lib/extensions names them). Named imports
// keep the bundle to these.
const SLOT_ICONS: Record<SlotIconName, LucideIcon> = {
  library: Library,
  radar: Radar,
  tv: Tv,
  music: Music,
  clapperboard: Clapperboard,
  settings: Settings,
  'layout-grid': LayoutGrid,
  server: Server,
  boxes: Boxes,
  globe: Globe,
  wrench: Wrench,
  'file-text': FileText,
  image: Image,
  'list-video': ListVideo,
  users: Users,
  gauge: Gauge,
  database: Database,
  puzzle: Puzzle,
};

interface ExtensionSlotProps {
  /** The slot's name, e.g. search.empty. */
  slot: string;
  /** Values a row's URL may carry ({q}: the search query). */
  vars?: Record<string, string>;
}

export function ExtensionSlot(props: ExtensionSlotProps): JSX.Element {
  return (
    <QuietBoundary>
      <SlotButtons {...props} />
    </QuietBoundary>
  );
}

/** What the line under the buttons says, about the button pressed last. */
type Note =
  | { kind: 'address'; href: string }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'failed' };

const NOTE_TEXT = {
  sending: 'Sending…',
  sent: 'Sent.',
  failed: "Couldn't send that. Try again.",
};

function SlotButtons({ slot, vars = {} }: ExtensionSlotProps): JSX.Element | null {
  const rows = useSlotRows(slot);
  const [note, setNote] = useState<Note | null>(null);
  const sending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const varsKey = JSON.stringify(vars);
  const buttons = useMemo(
    () => slotButtons(rows, serverOrigin(authStore.getApiBase()), vars),
    // vars is a fresh object each render; its values are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, varsKey],
  );
  if (buttons.length === 0) return null;

  const act = async (b: SlotButton): Promise<void> => {
    if (sending.current) return;
    sending.current = true;
    setNote({ kind: 'sending' });
    const token = await authStore.ensureFreshToken().catch(() => null);
    const result = await sendSlotAction({ href: b.href, token });
    sending.current = false;
    // An address shown meanwhile stays: the answer is about the line it replaced.
    if (alive.current) setNote((n) => (n?.kind === 'sending' ? { kind: result } : n));
  };

  const onEnter = (b: SlotButton): void => {
    if (b.kind === 'action') void act(b);
    else setNote({ kind: 'address', href: b.href });
  };

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="flex flex-wrap justify-center gap-4">
        {buttons.map((b) => {
          const Icon = SLOT_ICONS[b.icon];
          return (
            <Button key={b.key} icon={<Icon className="h-6 w-6" aria-hidden />} onEnter={() => onEnter(b)}>
              {b.label}
            </Button>
          );
        })}
      </div>
      {note?.kind === 'address' ? (
        <LinkAddress href={note.href} onClose={() => setNote(null)} />
      ) : (
        <p
          role="status"
          aria-live="polite"
          className={`min-h-[1.5em] text-lg ${note?.kind === 'failed' ? 'text-red' : 'text-muted'}`}
        >
          {note ? NOTE_TEXT[note.kind] : null}
        </p>
      )}
    </div>
  );
}

/** A link's address, to open somewhere with a browser — the way sign-in
 *  shows its own. BACK hides it while it shows (the most recent BACK
 *  subscriber is asked first). */
function LinkAddress({ href, onClose }: { href: string; onClose: () => void }): JSX.Element {
  useRemoteKey(TVKey.BACK, onClose);
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <p className="text-muted">On your phone or computer, open</p>
      <p className="max-w-4xl break-all text-2xl text-accent">{href}</p>
    </div>
  );
}

/** The slot's rows as chino-api answered, or null until then. Best effort: a
 *  call that fails leaves the slot empty. */
function useSlotRows(slot: string): unknown {
  const [rows, setRows] = useState<unknown>(null);
  useEffect(() => {
    let current = true;
    setRows(null);
    api
      .extensions(slot)
      .then((r) => {
        if (current) setRows(r);
      })
      .catch(() => {
        /* no rows: the slot shows nothing */
      });
    return () => {
      current = false;
    };
  }, [slot]);
  return rows;
}

export default ExtensionSlot;
