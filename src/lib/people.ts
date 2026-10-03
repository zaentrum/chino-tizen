// What the person page says about a person: dates in the browser's locale,
// their age, and the languages their biography is asked for in. Pure:
// people.test.ts runs it under node --test. Kept identical to chino-web's
// src/lib/people.ts.

interface DateParts {
  year: number;
  month?: number;
  day?: number;
}

/** A catalog date: YYYY-MM-DD as katalog-api sends them, or YYYY-MM / YYYY.
 *  undefined for anything else, an impossible day included. */
export function parseCatalogDate(iso: string | undefined): DateParts | undefined {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec((iso ?? '').trim());
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : undefined;
  const day = m[3] ? Number(m[3]) : undefined;
  if (month !== undefined && (month < 1 || month > 12)) return undefined;
  if (day !== undefined) {
    const d = new Date(Date.UTC(year, month! - 1, day));
    if (d.getUTCMonth() !== month! - 1 || d.getUTCDate() !== day) return undefined;
  }
  return { year, month, day };
}

/**
 * A catalog date in words, in `locales` — the browser's own when left out:
 * "March 3, 1957" (en-US), "3 March 1957" (en-GB), "3. März 1957" (de). A
 * year-month or a year alone is written as far as it goes. Anything that is
 * not a date comes back as it was rather than as nothing.
 */
export function formatCatalogDate(iso: string | undefined, locales?: Intl.LocalesArgument): string {
  const raw = (iso ?? '').trim();
  const p = parseCatalogDate(raw);
  if (!p) return raw;
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', timeZone: 'UTC' };
  if (p.month) options.month = 'long';
  if (p.day) options.day = 'numeric';
  try {
    return new Intl.DateTimeFormat(locales, options).format(Date.UTC(p.year, (p.month ?? 1) - 1, p.day ?? 1));
  } catch {
    return raw; // a locale Intl rejects: the date as the catalog has it
  }
}

/** Whole years from `born` to `on`, both full catalog dates; undefined when
 *  either is not one, or `on` comes first. */
export function ageInYears(born: string | undefined, on: string | undefined): number | undefined {
  const b = parseCatalogDate(born);
  const o = parseCatalogDate(on);
  if (!b?.month || !b.day || !o?.month || !o.day) return undefined;
  let age = o.year - b.year;
  if (o.month < b.month || (o.month === b.month && o.day < b.day)) age -= 1;
  return age >= 0 ? age : undefined;
}

/** Today in the browser's time zone, as a catalog date (YYYY-MM-DD). */
export function todayCatalogDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * An Accept-Language header for the browser's languages, most wanted first
 * (navigator.languages): "de-CH, de;q=0.9, en;q=0.8". katalog-api picks a
 * person's biography from it, falling back to English; ?lang= would name one
 * language only. Tags that are not language tags are left out; at most ten.
 * Empty when there are none.
 */
export function acceptLanguage(languages: readonly string[] | undefined): string {
  const tags: string[] = [];
  for (const raw of languages ?? []) {
    const tag = raw.trim();
    if (!/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag)) continue;
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    tags.push(tag);
    if (tags.length === 10) break;
  }
  return tags.map((tag, i) => (i === 0 ? tag : `${tag};q=${(1 - i / 10).toFixed(1)}`)).join(', ');
}
