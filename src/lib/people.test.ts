// node --test (type stripping, Node >= 22.18): the person page's dates, age
// and Accept-Language. Excluded from the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptLanguage, ageInYears, formatCatalogDate, parseCatalogDate, todayCatalogDate } from './people.ts';

test('a birth date in the browser’s locale', () => {
  assert.equal(formatCatalogDate('1957-03-03', 'en-US'), 'March 3, 1957');
  assert.equal(formatCatalogDate('1957-03-03', 'en-GB'), '3 March 1957');
  assert.equal(formatCatalogDate('1957-03-03', 'de-CH'), '3. März 1957');
  assert.equal(formatCatalogDate('1957-03-03', ['fr-CH', 'en']), '3 mars 1957');
});

test('no day is lost to a time zone: the date is the calendar day the catalog names', () => {
  // Midnight UTC is still the previous evening west of Greenwich; formatting
  // in UTC keeps the 1st the 1st there.
  assert.equal(formatCatalogDate('2000-01-01', 'en-US'), 'January 1, 2000');
  assert.equal(formatCatalogDate('1999-12-31', 'en-US'), 'December 31, 1999');
});

test('a year-month or a year is written as far as it goes; anything else as it was', () => {
  assert.equal(formatCatalogDate('1957-03', 'en-US'), 'March 1957');
  assert.equal(formatCatalogDate('1957', 'en-US'), '1957');
  assert.equal(formatCatalogDate('circa 1957', 'en-US'), 'circa 1957');
  assert.equal(formatCatalogDate('1957-02-30', 'en-US'), '1957-02-30');
  assert.equal(formatCatalogDate(undefined, 'en-US'), '');
  assert.equal(formatCatalogDate(' 1957-03-03 ', 'en-US'), 'March 3, 1957');
});

test('a locale Intl rejects does not take the page down', () => {
  assert.equal(formatCatalogDate('1957-03-03', 'not a locale!'), '1957-03-03');
});

test('parseCatalogDate', () => {
  assert.deepEqual(parseCatalogDate('1957-03-03'), { year: 1957, month: 3, day: 3 });
  assert.deepEqual(parseCatalogDate('2024-02-29'), { year: 2024, month: 2, day: 29 });
  assert.equal(parseCatalogDate('2023-02-29'), undefined);
  assert.equal(parseCatalogDate('1957-13-01'), undefined);
  assert.equal(parseCatalogDate('03.03.1957'), undefined);
});

test('the age turns on the birthday, not before', () => {
  assert.equal(ageInYears('1957-03-03', '2026-03-02'), 68);
  assert.equal(ageInYears('1957-03-03', '2026-03-03'), 69);
  assert.equal(ageInYears('1957-03-03', '2026-10-03'), 69);
  assert.equal(ageInYears('1980-11-20', '2024-02-10'), 43);
  assert.equal(ageInYears('2000-02-29', '2001-02-28'), 0);
  assert.equal(ageInYears('2000-02-29', '2001-03-01'), 1);
});

test('no age without two full dates, nor before the birth', () => {
  assert.equal(ageInYears('1957', '2026-10-03'), undefined);
  assert.equal(ageInYears('1957-03-03', undefined), undefined);
  assert.equal(ageInYears(undefined, '2026-10-03'), undefined);
  assert.equal(ageInYears('1957-03-03', '1956-01-01'), undefined);
});

test('today, in the local calendar', () => {
  assert.equal(todayCatalogDate(new Date(2026, 9, 3, 23, 59)), '2026-10-03');
  assert.equal(todayCatalogDate(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
});

test('Accept-Language: the browser’s languages, most wanted first', () => {
  assert.equal(acceptLanguage(['en-US']), 'en-US');
  assert.equal(acceptLanguage(['de-CH', 'de', 'en']), 'de-CH, de;q=0.9, en;q=0.8');
  assert.equal(acceptLanguage(['fr', 'FR', ' it ']), 'fr, it;q=0.9');
  assert.equal(acceptLanguage(['de', 'x y', 'en;q=1', '']), 'de');
  assert.equal(acceptLanguage([]), '');
  assert.equal(acceptLanguage(undefined), '');
  const many = acceptLanguage(Array.from({ length: 12 }, (_, i) => `l${String.fromCharCode(97 + i)}`));
  assert.equal(many.split(', ').length, 10);
  assert.match(many, /lj;q=0\.1$/);
});
