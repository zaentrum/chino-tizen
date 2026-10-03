// Geometry-based spatial navigation engine for the Tizen TV shell.
//
// Every screen, rail, row and grid drives its D-pad interactivity through this
// module — it is the linchpin of the 10-foot UX. There is ONE global keydown
// listener (installed by <FocusProvider>). Arrow keys move the current focus to
// the nearest registered focusable in that direction (computed from
// getBoundingClientRect: direction filtering + centre-distance + axis-overlap
// scoring, the classic spatial-navigation heuristic). ENTER fires the focused
// element's onEnter. The focused element gets `data-focused="true"` (the shell's
// CSS paints the blue ring off that attribute) and is scrolled into view.
//
// BACK / MEDIA-transport / CHANNEL keys are deliberately NOT consumed here: they
// are routed to per-element subscribers registered via useRemoteKey() so the
// player, Zap and individual screens own those keys while mounted (most-recent
// subscriber wins, mirroring chino-androidtv's onPreviewKeyEvent precedence).
//
// The focus model mirrors chino-androidtv (LibraryScreen / SearchScreen):
//   - an invisible "catcher" focusable (autoFocus) can hold focus on entry so a
//     screen reads as "nothing selected" yet still receives the first key, then
//     hands off — emulate by giving the catcher an onFocus that focusKey()s the
//     real target, or simply autoFocus the intended first element directly;
//   - explicit DOWN-to-first-result handoffs are expressed by focusing a known
//     focusKey from an onEnter / effect (e.g. SearchScreen's search field → first
//     result card);
//   - focus restoration on re-entry is just autoFocus on the element a screen
//     wants to land on (hero Play, search field, …).

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { TVKey } from './keys';

/* ──────────────────────────────  Types  ────────────────────────────────── */

type Direction = 'left' | 'up' | 'right' | 'down';

interface Focusable {
  el: HTMLElement;
  onEnter?: () => void;
  onFocus?: () => void;
  focusKey?: string;
  disabled: boolean;
}

interface RemoteSub {
  /** Key codes this subscriber listens for. */
  codes: number[];
  handler: (e: KeyboardEvent) => void;
}

/* The public engine surface shared through context. It is intentionally plain
   (not React state) — focus is imperative DOM-adjacent state that must not
   re-render the whole tree on every D-pad press. A component observes only its
   own focus, via the `focused` boolean from useFocusable (a tiny per-element
   subscription). */
interface FocusEngine {
  register(f: Focusable): void;
  unregister(el: HTMLElement): void;
  /** Patch mutable fields (onEnter/onFocus/focusKey/disabled) in place. */
  update(el: HTMLElement, patch: Partial<Focusable>): void;
  focus(el: HTMLElement | null, opts?: { scroll?: boolean }): void;
  focusKey(key: string): boolean;
  focusFirst(within?: HTMLElement): boolean;
  /** Per-element focus-change subscription used by useFocusable. */
  subscribe(el: HTMLElement, cb: (focused: boolean) => void): () => void;
  subscribeRemote(sub: RemoteSub): () => void;
  current(): HTMLElement | null;
}

/* ───────────────────────────  Geometry helpers  ─────────────────────────── */

interface Rect {
  cx: number;
  cy: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return {
    cx: r.left + r.width / 2,
    cy: r.top + r.height / 2,
    left: r.left,
    right: r.right,
    top: r.top,
    bottom: r.bottom,
  };
}

/** Is `el` connected and laid out (non-zero box)? display:none / detached nodes
 *  are skipped so a hidden card never steals focus. */
function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

const isNavCode = (code: number): boolean =>
  code === TVKey.LEFT ||
  code === TVKey.UP ||
  code === TVKey.RIGHT ||
  code === TVKey.DOWN ||
  code === TVKey.ENTER;

/**
 * Score a candidate rect against the origin rect for movement in `dir`.
 * Lower is better; Infinity means "not a candidate in this direction".
 *
 * The heuristic is the one TV spatial-navigation libs converge on:
 *   - the candidate must lie in the requested direction (its centre must be
 *     past the origin centre on the primary axis);
 *   - primary-axis travel distance dominates the score so focus steps to the
 *     nearest row/column first;
 *   - cross-axis offset is added but down-weighted; an OVERLAP test pulls the
 *     score down hard for in-line candidates (keeps you in the same visual
 *     column going up/down a grid, and lands a row→row jump on the card nearest
 *     the current x).
 */
function score(origin: Rect, cand: Rect, dir: Direction): number {
  const horizontal = dir === 'left' || dir === 'right';
  let primary: number; // edge-to-edge gap along the movement axis
  let cross: number; // |offset| on the perpendicular axis (centre-to-centre)
  let overlap: number; // shared extent on the perpendicular axis (px)
  let centreDelta: number; // signed centre travel along the movement axis

  if (horizontal) {
    primary = dir === 'right' ? cand.left - origin.right : origin.left - cand.right;
    cross = Math.abs(cand.cy - origin.cy);
    overlap = Math.min(origin.bottom, cand.bottom) - Math.max(origin.top, cand.top);
    centreDelta = dir === 'right' ? cand.cx - origin.cx : origin.cx - cand.cx;
  } else {
    primary = dir === 'down' ? cand.top - origin.bottom : origin.top - cand.bottom;
    cross = Math.abs(cand.cx - origin.cx);
    overlap = Math.min(origin.right, cand.right) - Math.max(origin.left, cand.left);
    centreDelta = dir === 'down' ? cand.cy - origin.cy : origin.cy - cand.cy;
  }

  // Must actually be in the requested direction. Centre delta is robust to the
  // sub-pixel gaps that make edge-based `primary` slightly negative for
  // adjacent same-row cards.
  if (centreDelta <= 1) return Infinity;

  const primaryDist = Math.max(primary, 0);
  const inLine = overlap > 0;
  const CROSS_WEIGHT = 0.5;
  const OFFLINE_PENALTY = inLine ? 0 : 100000;

  return primaryDist + cross * CROSS_WEIGHT + OFFLINE_PENALTY;
}

/* ─────────────────────────  Engine + key driver  ───────────────────────── */

interface FocusDriver {
  engine: FocusEngine;
  handleKey(e: KeyboardEvent): void;
}

/** Build the engine and its keydown driver together so the global key handler
 *  can reach `move()` and the remote subscribers (which aren't on the public
 *  engine surface) through shared closures. */
function createDriver(): FocusDriver {
  const registry = new Map<HTMLElement, Focusable>();
  const watchers = new Map<HTMLElement, Set<(focused: boolean) => void>>();
  // remoteSubs is iterated from the END so the most-recently-mounted subscriber
  // (player / overlay) gets first refusal over the underlying screen.
  const remoteSubs: RemoteSub[] = [];
  let currentEl: HTMLElement | null = null;

  const notify = (el: HTMLElement, focused: boolean) => {
    const set = watchers.get(el);
    if (set) for (const cb of set) cb(focused);
  };

  const setCurrent = (el: HTMLElement | null, scroll: boolean) => {
    if (el === currentEl) return;
    const prev = currentEl;
    currentEl = el;
    if (prev) {
      prev.removeAttribute('data-focused');
      notify(prev, false);
    }
    if (el) {
      el.setAttribute('data-focused', 'true');
      registry.get(el)?.onFocus?.();
      notify(el, true);
      if (scroll) {
        // block/inline: 'nearest' keeps the element visible with minimal scroll
        // — the right feel for horizontal rails and vertical page scroll alike.
        try {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch {
          /* jsdom / very old runtimes — non-fatal */
        }
      }
    }
  };

  const candidates = (): Focusable[] => {
    const out: Focusable[] = [];
    for (const f of registry.values()) {
      if (f.disabled || !isVisible(f.el)) continue;
      out.push(f);
    }
    return out;
  };

  /** First focusable in reading order (top-to-bottom, then left-to-right) —
   *  used for "nothing focused yet" fallback and focusFirst(). An 8px vertical
   *  tolerance keeps a single row's cards sorted left-to-right despite sub-pixel
   *  y jitter. */
  const pickFirst = (list: Focusable[], within?: HTMLElement): Focusable | null => {
    const pool = within ? list.filter((f) => within.contains(f.el)) : list;
    if (pool.length === 0) return null;
    return pool.reduce((a, b) => {
      const ra = rectOf(a.el);
      const rb = rectOf(b.el);
      if (Math.abs(ra.top - rb.top) > 8) return ra.top < rb.top ? a : b;
      return ra.left <= rb.left ? a : b;
    });
  };

  const move = (dir: Direction): boolean => {
    const list = candidates();
    if (list.length === 0) return false;

    // Nothing focused (or the focused node went away) → engage the first
    // focusable so a stray arrow always lands somewhere.
    if (!currentEl || !registry.has(currentEl) || !isVisible(currentEl)) {
      const first = pickFirst(list);
      if (first) {
        setCurrent(first.el, true);
        return true;
      }
      return false;
    }

    const origin = rectOf(currentEl);
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const f of list) {
      if (f.el === currentEl) continue;
      const s = score(origin, rectOf(f.el), dir);
      if (s < bestScore) {
        bestScore = s;
        best = f.el;
      }
    }
    if (best && bestScore < Infinity) {
      setCurrent(best, true);
      return true;
    }
    return false;
  };

  const engine: FocusEngine = {
    register(f) {
      registry.set(f.el, f);
    },
    unregister(el) {
      registry.delete(el);
      watchers.delete(el);
      // Don't auto-jump elsewhere on unmount — let the screen's autoFocus or the
      // next arrow press re-establish focus. Just clear the pointer so a stale
      // node is never treated as current.
      if (currentEl === el) currentEl = null;
    },
    update(el, patch) {
      const entry = registry.get(el);
      if (entry) Object.assign(entry, patch);
    },
    focus(el, opts) {
      if (el && (!registry.has(el) || registry.get(el)!.disabled)) return;
      setCurrent(el, opts?.scroll ?? true);
    },
    focusKey(key) {
      for (const f of registry.values()) {
        if (f.focusKey === key && !f.disabled && isVisible(f.el)) {
          setCurrent(f.el, true);
          return true;
        }
      }
      return false;
    },
    focusFirst(within) {
      const f = pickFirst(candidates(), within);
      if (f) {
        setCurrent(f.el, true);
        return true;
      }
      return false;
    },
    subscribe(el, cb) {
      let set = watchers.get(el);
      if (!set) {
        set = new Set();
        watchers.set(el, set);
      }
      set.add(cb);
      return () => {
        set!.delete(cb);
      };
    },
    subscribeRemote(sub) {
      remoteSubs.push(sub);
      return () => {
        const i = remoteSubs.indexOf(sub);
        if (i >= 0) remoteSubs.splice(i, 1);
      };
    },
    current: () => currentEl,
  };

  const handleKey = (e: KeyboardEvent) => {
    const code = e.keyCode || e.which;

    // 1) Remote subscribers (BACK / MEDIA / CHANNEL / custom) get first refusal.
    //    Most-recently-mounted wins (iterate from the end). A subscriber that
    //    calls preventDefault ends dispatch — the engine then won't also act on
    //    the key (e.g. an overlay that wants UP/DOWN for itself). For non-nav
    //    keys (BACK/MEDIA/CHANNEL) the engine has nothing to do, so we stop
    //    after delivering to the top subscriber regardless.
    for (let i = remoteSubs.length - 1; i >= 0; i--) {
      const sub = remoteSubs[i];
      if (sub.codes.includes(code)) {
        sub.handler(e);
        if (e.defaultPrevented) return;
        if (!isNavCode(code)) return;
      }
    }

    // 2) Built-in spatial navigation for the D-pad arrows + ENTER.
    switch (code) {
      case TVKey.LEFT:
        if (move('left')) e.preventDefault();
        break;
      case TVKey.UP:
        if (move('up')) e.preventDefault();
        break;
      case TVKey.RIGHT:
        if (move('right')) e.preventDefault();
        break;
      case TVKey.DOWN:
        if (move('down')) e.preventDefault();
        break;
      case TVKey.ENTER: {
        if (currentEl) {
          const entry = registry.get(currentEl);
          if (entry && !entry.disabled && entry.onEnter) {
            entry.onEnter();
            e.preventDefault();
          }
        }
        break;
      }
      default:
        break;
    }
  };

  return { engine, handleKey };
}

/* ──────────────────────────────  Context  ──────────────────────────────── */

const FocusContext = createContext<FocusEngine | null>(null);

function useEngine(): FocusEngine {
  const e = useContext(FocusContext);
  if (!e) {
    throw new Error('useFocusable / useRemoteKey must be used inside <FocusProvider>');
  }
  return e;
}

// Module-level handle so the imperative helpers (focusKey/focusFirst) can be
// called from outside React (e.g. a route-change effect) without threading the
// engine through props. Set while the single provider is mounted.
let activeEngine: FocusEngine | null = null;

/* ──────────────────────────────  Provider  ─────────────────────────────── */

export function FocusProvider({ children }: { children: ReactNode }): JSX.Element {
  // One driver per provider instance, stable across re-renders.
  const driverRef = useRef<FocusDriver | null>(null);
  if (!driverRef.current) driverRef.current = createDriver();
  const driver = driverRef.current;

  useEffect(() => {
    activeEngine = driver.engine;
    const onKey = (e: KeyboardEvent) => driver.handleKey(e);
    // capture:true so we see the key before any element's own listeners and can
    // claim arrow/enter before the browser's default focus walk runs.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (activeEngine === driver.engine) activeEngine = null;
    };
  }, [driver]);

  return <FocusContext.Provider value={driver.engine}>{children}</FocusContext.Provider>;
}

/* ────────────────────────────  useFocusable  ───────────────────────────── */

export interface UseFocusableOptions {
  onEnter?: () => void;
  onFocus?: () => void;
  focusKey?: string;
  autoFocus?: boolean;
  /** Scroll the element into view when autoFocus focuses it on mount
   *  (default true). False keeps the page where it is — for a first item
   *  below a header the screen wants seen on entry. */
  autoFocusScroll?: boolean;
  disabled?: boolean;
}

export interface UseFocusableResult {
  /** Attach to the focusable element: `<div ref={ref}>`. */
  ref: (el: HTMLElement | null) => void;
  /** True while this element holds focus — drives any extra in-component
   *  styling on top of the CSS `[data-focused]` ring. */
  focused: boolean;
}

export function useFocusable(opts: UseFocusableOptions = {}): UseFocusableResult {
  const engine = useEngine();
  const elRef = useRef<HTMLElement | null>(null);
  const unsubRef = useRef<(() => void) | undefined>(undefined);
  const [focused, setFocused] = useState(false);

  // Keep the latest callbacks/flags reachable from the stable registry entry
  // without re-registering each render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Stable ref callback: register synchronously as the DOM node appears (so
  // geometry is queryable immediately and autoFocus can fire), unregister on
  // detach.
  const refFn = useRef<(el: HTMLElement | null) => void>();
  if (!refFn.current) {
    refFn.current = (el: HTMLElement | null) => {
      const prev = elRef.current;
      if (prev && prev !== el) {
        unsubRef.current?.();
        unsubRef.current = undefined;
        engine.unregister(prev);
      }
      elRef.current = el;
      if (el) {
        engine.register({
          el,
          onEnter: optsRef.current.onEnter ? () => optsRef.current.onEnter?.() : undefined,
          onFocus: optsRef.current.onFocus ? () => optsRef.current.onFocus?.() : undefined,
          focusKey: optsRef.current.focusKey,
          disabled: !!optsRef.current.disabled,
        });
        unsubRef.current = engine.subscribe(el, setFocused);
        if (optsRef.current.autoFocus) {
          // Defer one microtask so all sibling focusables from the same commit
          // are registered first, and layout has settled for scrollIntoView.
          queueMicrotask(() => {
            if (elRef.current === el && engine.current() !== el) {
              engine.focus(el, { scroll: optsRef.current.autoFocusScroll !== false });
            }
          });
        }
      }
    };
  }

  // Push mutable fields to the engine entry every render so handlers never go
  // stale and a disabled toggle takes effect.
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    engine.update(el, {
      onEnter: opts.onEnter ? () => optsRef.current.onEnter?.() : undefined,
      onFocus: opts.onFocus ? () => optsRef.current.onFocus?.() : undefined,
      focusKey: opts.focusKey,
      disabled: !!opts.disabled,
    });
    if (opts.disabled && engine.current() === el) {
      el.removeAttribute('data-focused');
    }
  });

  // Final cleanup on unmount.
  useEffect(() => {
    return () => {
      const el = elRef.current;
      if (el) {
        unsubRef.current?.();
        engine.unregister(el);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ref: refFn.current, focused };
}

/* ────────────────────────────  useRemoteKey  ───────────────────────────── */

/**
 * Subscribe to one or more raw remote key codes while the component is mounted.
 * Used by the player (MEDIA_*), Zap (CHANNEL_*) and every screen (BACK). The
 * handler runs BEFORE the engine's built-in arrow/enter navigation; call
 * `e.preventDefault()` inside the handler to stop the engine also acting on the
 * key (e.g. when an overlay wants UP/DOWN for itself).
 *
 * Most-recently-mounted subscriber for a given code fires first — so a player or
 * modal overlay on top of a screen intercepts before the screen does.
 */
export function useRemoteKey(
  keyCode: number | number[],
  handler: (e: KeyboardEvent) => void,
): void {
  const engine = useEngine();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // Stabilise the code list so an inline array literal doesn't churn the
  // subscription on every render.
  const codes = Array.isArray(keyCode) ? keyCode : [keyCode];
  const codesKey = codes.join(',');

  useEffect(() => {
    const sub: RemoteSub = {
      codes: codesKey.split(',').map(Number),
      handler: (e) => handlerRef.current(e),
    };
    return engine.subscribeRemote(sub);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, codesKey]);
}

/* ─────────────────────────  Imperative helpers  ─────────────────────────── */

/** Move focus to the focusable registered with the given focusKey. Returns
 *  false (no-op) if none is registered/visible. */
export function focusKey(key: string): boolean {
  return activeEngine?.focusKey(key) ?? false;
}

/** Move focus to the first focusable in reading order, optionally scoped to a
 *  container. Handy for "DOWN into the first result" after a screen loads. */
export function focusFirst(within?: HTMLElement): boolean {
  return activeEngine?.focusFirst(within) ?? false;
}
