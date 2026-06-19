// Playback / UX preferences, persisted to localStorage. Field set mirrors
// chino-androidtv's SettingsViewModel (autoSkipIntro / autoSkipCredits /
// autoPlayNext / preferredAudioLang) plus the two the contract adds for the
// Tizen player: skipCountdownSec (how long the auto-skip-credits "Next episode
// in N…" countdown runs) and preferredSubtitleLang. The player + screens read
// the live value through useSettings(); writes go through the store's setters,
// which fan out to every subscribed hook so a toggle in Settings updates the
// player chrome immediately.
import { useEffect, useState } from 'react';

export interface Settings {
  /** Auto-skip a detected intro segment when the playhead enters it. */
  autoSkipIntro: boolean;
  /** Auto-skip the closing-credits segment (and offer the next episode). */
  autoSkipCredits: boolean;
  /** Auto-roll the next episode after one finishes. */
  autoPlayNext: boolean;
  /** Seconds the "Next episode in N…" / "Skip credits" countdown shows. */
  skipCountdownSec: number;
  /** Preferred audio track language (BCP-47 / ISO code), if any. */
  preferredAudioLang?: string;
  /** Preferred subtitle track language (BCP-47 / ISO code), if any. */
  preferredSubtitleLang?: string;
}

const KEY = 'chino.settings';

const DEFAULTS: Settings = {
  autoSkipIntro: true,
  autoSkipCredits: true,
  autoPlayNext: true,
  skipCountdownSec: 10,
};

function load(): Settings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Merge over defaults so a stored blob written by an older build (missing
    // a field added later) still yields a complete, well-typed Settings.
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

// Single in-memory copy + a subscriber set. Every useSettings() hook listens;
// any setter writes through, persists, and notifies — so the UI stays in sync
// across the Settings screen and the player chrome without a context provider.
let current: Settings = load();
const listeners = new Set<() => void>();

function persist(): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage disabled — keep the in-memory value for this session */
  }
}

function emit(): void {
  for (const l of listeners) l();
}

/** Patch one or more fields and notify subscribers. */
function update(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  persist();
  emit();
}

export const settingsStore = {
  get(): Settings {
    return current;
  },
  set: update,
  setAutoSkipIntro: (v: boolean) => update({ autoSkipIntro: v }),
  setAutoSkipCredits: (v: boolean) => update({ autoSkipCredits: v }),
  setAutoPlayNext: (v: boolean) => update({ autoPlayNext: v }),
  setSkipCountdownSec: (v: number) => update({ skipCountdownSec: v }),
  setPreferredAudioLang: (v: string | undefined) =>
    update({ preferredAudioLang: v }),
  setPreferredSubtitleLang: (v: string | undefined) =>
    update({ preferredSubtitleLang: v }),
};

/**
 * Subscribe a component to the live settings. Returns the current Settings
 * snapshot plus a `set` patcher; the component re-renders whenever any setter
 * mutates the store (incl. from another screen).
 */
export function useSettings(): {
  settings: Settings;
  set: (patch: Partial<Settings>) => void;
} {
  const [snapshot, setSnapshot] = useState<Settings>(current);
  useEffect(() => {
    const sub = () => setSnapshot(current);
    listeners.add(sub);
    // Reconcile in case the store changed between render and effect commit.
    sub();
    return () => {
      listeners.delete(sub);
    };
  }, []);
  return { settings: snapshot, set: update };
}
