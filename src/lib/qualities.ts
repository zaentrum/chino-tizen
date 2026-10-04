// The player's quality menu, from /play/info: what it offers and which entry
// the player is on. Pure: qualities.test.ts runs it under node --test.
//
// chino-stream serves a packaged title as the ladder of rungs this TV decodes
// (its caps), or one rung of it. /play/info's qualities lists the choice:
// Auto — the ladder, which the engine steps through by itself (AVPlay's own
// adaptive streaming, hls.js's ABR) — then the rungs, tallest first, each
// named by its picture size ("720p"); null when there is nothing to choose,
// a package of one rendition. An on-the-fly title lists the transcode ladder
// instead (high, medium, low). A pick reloads the master with q=<name> at the
// position played; Auto is q=auto. Mirrors chino-web's lib/qualities.ts.

/** The ?q= of a packaged title's ladder. */
export const AUTO = 'auto';

/** An entry of the menu: the ?q= value and what the menu says. */
export interface Quality {
  id: string;
  label: string;
}

/**
 * The quality menu for /play/info: a packaged title's Auto and rungs, Auto
 * first (put there should the server leave it out); an on-the-fly title's
 * ladder as the server lists it. Empty when there are fewer than two
 * entries to show, or no play info.
 */
export function qualityMenu(
  info: { mode?: string; qualities?: readonly Quality[] | null } | null | undefined,
): Quality[] {
  if (!info || !Array.isArray(info.qualities)) return [];
  const seen = new Set<string>();
  const entries = info.qualities.filter((e): e is Quality => {
    if (!e || typeof e.id !== 'string' || !e.id || typeof e.label !== 'string' || !e.label) return false;
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  if (entries.length < 2) return [];
  if (info.mode !== 'packaged') return entries;
  const auto = entries.find((e) => e.id === AUTO) ?? { id: AUTO, label: 'Auto' };
  return [auto, ...entries.filter((e) => e.id !== AUTO)];
}

/**
 * The entry the player is on for the q it asked with: the entry of that
 * name, else Auto — what chino-stream serves a packaged title for any other
 * q (auto, an on-the-fly "high", a rung this TV can no longer pick) — else
 * the first entry (an on-the-fly ladder starts on high, its first). Null for
 * an empty menu.
 */
export function chosenQuality(menu: readonly Quality[], q: string | null | undefined): Quality | null {
  if (menu.length === 0) return null;
  return menu.find((e) => e.id === q) ?? menu.find((e) => e.id === AUTO) ?? menu[0];
}
