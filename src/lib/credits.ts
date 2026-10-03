// A title's credits as the detail page shows them — the actors, then the crew
// grouped by role under a label — and a person's roles on a title as the
// person page names them. Pure: credits.test.ts runs it under node --test.
// Kept identical to chino-web's src/lib/credits.ts, so both clients list a
// title's credits alike.
import type { CastEntry } from '../api/types';

/**
 * The roles chino has names for, in the order the detail page lists them:
 * katalog-api's vocabulary, in katalog-api's order. A role is an open token,
 * so any other one is valid too; it is shown titleized, after these.
 */
export const KNOWN_ROLES: readonly string[] = [
  'actor',
  'creator',
  'director',
  'writer',
  'producer',
  'composer',
  'cinematographer',
  'editor',
];

/** The label over a role's names on the detail page: [one, several]. */
const GROUP_LABELS = new Map<string, [string, string]>([
  ['actor', ['Starring', 'Starring']],
  ['creator', ['Created by', 'Created by']],
  ['director', ['Director', 'Directors']],
  ['writer', ['Writer', 'Writers']],
  ['producer', ['Producer', 'Producers']],
  ['composer', ['Music', 'Music']],
  ['cinematographer', ['Cinematography', 'Cinematography']],
  ['editor', ['Editor', 'Editors']],
]);

/** A person's role on a title, as a filmography card names it. */
const ROLE_NAMES = new Map<string, string>([
  ['actor', 'Actor'],
  ['creator', 'Creator'],
  ['director', 'Director'],
  ['writer', 'Writer'],
  ['producer', 'Producer'],
  ['composer', 'Composer'],
  ['cinematographer', 'Cinematographer'],
  ['editor', 'Editor'],
]);

export interface CreditGroup {
  /** The role token ("director", "sound-designer"). */
  role: string;
  /** What the detail page writes over the names ("Directors", "Music"). */
  label: string;
  people: CastEntry[];
}

export interface GroupedCredits {
  /** The actors, in the order katalog-api sends them: billing order. */
  actors: CastEntry[];
  /** Every other role, known roles first in KNOWN_ROLES order, then the rest as they come. */
  crew: CreditGroup[];
}

/** A credit's role as a lower-case token. A credit without one is an actor:
 *  catalogs from before roles were sent credited actors only. */
export function roleOf(credit: { role?: string }): string {
  return (credit.role ?? '').trim().toLowerCase() || 'actor';
}

/** An unknown role token as words: "sound-designer" → "Sound Designer". */
export function titleizeRole(role: string): string {
  return role
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** The label over `count` names in `role`: "Director" for one, "Directors" for two. */
export function creditLabel(role: string, count: number): string {
  const r = role.trim().toLowerCase();
  const label = GROUP_LABELS.get(r);
  if (!label) return titleizeRole(r);
  return count > 1 ? label[1] : label[0];
}

/**
 * Split a title's credits into its actors and its crew by role. The order
 * within a role is the order the credits arrive in (katalog-api sends billing
 * order); roles are listed known ones first. A person credited twice in one
 * role is listed once, with both characters — two links with one name in one
 * block would only read as a mistake.
 */
export function groupCredits(cast: readonly CastEntry[] | undefined): GroupedCredits {
  const byRole = new Map<string, CastEntry[]>();
  const kept = new Map<string, CastEntry>();
  for (const credit of cast ?? []) {
    const name = credit?.name?.trim();
    if (!name) continue;
    const role = roleOf(credit);
    const key = `${role}\u0000${credit.person_id || name}`;
    const earlier = kept.get(key);
    if (earlier) {
      const character = credit.character?.trim();
      if (character && !(earlier.character ?? '').split(' / ').includes(character)) {
        earlier.character = earlier.character ? `${earlier.character} / ${character}` : character;
      }
      continue;
    }
    const entry: CastEntry = { ...credit, name, role };
    kept.set(key, entry);
    const list = byRole.get(role);
    if (list) list.push(entry);
    else byRole.set(role, [entry]);
  }

  const rank = (role: string) => {
    const i = KNOWN_ROLES.indexOf(role);
    return i < 0 ? KNOWN_ROLES.length : i;
  };
  const crew = [...byRole.keys()]
    .filter((role) => role !== 'actor')
    // A stable sort: roles chino has no name for keep the order they came in.
    .sort((a, b) => rank(a) - rank(b))
    .map((role) => {
      const people = byRole.get(role) ?? [];
      return { role, label: creditLabel(role, people.length), people };
    });
  return { actors: byRole.get('actor') ?? [], crew };
}

/** A person's role on one title, for their filmography: "Director", "Composer". */
export function roleName(role: string): string {
  const r = role.trim().toLowerCase();
  return ROLE_NAMES.get(r) ?? titleizeRole(r);
}

/** A person's roles on a title, each once, in the order given: "Director · Writer". */
export function formatRoles(roles: readonly string[] | undefined): string {
  const names: string[] = [];
  for (const role of roles ?? []) {
    const name = roleName(role);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(' · ');
}
