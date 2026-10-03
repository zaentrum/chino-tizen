// node --test (type stripping, Node >= 22.18): the pure helpers behind the
// detail page's credits and the person page's roles. Excluded from the app's
// tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditLabel, formatRoles, groupCredits, roleName, roleOf, titleizeRole } from './credits.ts';

const credit = (name: string, role?: string, extra: Record<string, unknown> = {}) => ({
  person_id: `id-${name}`,
  name,
  role,
  ...extra,
});

test('the crew is grouped by role, known roles in display order, others after them as they came', () => {
  const { actors, crew } = groupCredits([
    credit('Esther Wouda', 'writer'),
    credit('Halina Reijn', 'actor', { character: 'Sintel (voice)', order: 0 }),
    credit('Jan Morgenstern', 'composer'),
    credit('Rob Tuytel', 'visual-effects'),
    credit('Colin Levy', 'director'),
    credit('Thom Hoffman', 'actor', { character: 'Shaman (voice)', order: 1 }),
    credit('Joram Letwory', 'sound-designer'),
    credit('Ton Roosendaal', 'producer'),
    credit('Josh Bernhard', 'creator'),
  ]);
  assert.deepEqual(
    actors.map((a) => a.name),
    ['Halina Reijn', 'Thom Hoffman'],
  );
  assert.deepEqual(
    crew.map((g) => [g.role, g.label]),
    [
      ['creator', 'Created by'],
      ['director', 'Director'],
      ['writer', 'Writer'],
      ['producer', 'Producer'],
      ['composer', 'Music'],
      ['visual-effects', 'Visual Effects'],
      ['sound-designer', 'Sound Designer'],
    ],
  );
});

test('the order within a role is the order the credits arrive in (billing order)', () => {
  const leads = ['Alexandra Blatt', 'Laura Graham', 'James Rich', 'Einar Gunn', 'Jack Haley'];
  const { actors } = groupCredits(leads.map((n, i) => credit(n, 'actor', { order: i })));
  assert.deepEqual(
    actors.map((a) => a.name),
    leads,
  );
});

test('a credit without a role is an actor; role tokens are matched case-insensitively', () => {
  const { actors, crew } = groupCredits([
    credit('A'),
    credit('B', ''),
    credit('C', ' Actor '),
    credit('D', 'DIRECTOR'),
  ]);
  assert.deepEqual(
    actors.map((a) => [a.name, a.role]),
    [
      ['A', 'actor'],
      ['B', 'actor'],
      ['C', 'actor'],
    ],
  );
  assert.deepEqual(
    crew.map((g) => [g.role, g.people.map((p) => p.name)]),
    [['director', ['D']]],
  );
});

test('a person credited twice in one role is listed once, with both characters', () => {
  const { actors, crew } = groupCredits([
    credit('Ian Hubert', 'director'),
    credit('Ian Hubert', 'director'),
    credit('Ian Hubert', 'writer'),
    credit('Derek de Lint', 'actor', { character: 'Old Thom' }),
    credit('Derek de Lint', 'actor', { character: 'Narrator' }),
    credit('Derek de Lint', 'actor', { character: 'Old Thom' }),
  ]);
  assert.deepEqual(
    crew.map((g) => [g.label, g.people.map((p) => p.name)]),
    [
      ['Director', ['Ian Hubert']],
      ['Writer', ['Ian Hubert']],
    ],
  );
  assert.equal(actors.length, 1);
  assert.equal(actors[0].character, 'Old Thom / Narrator');
});

test('without a person_id, the name tells credits apart; nameless credits are dropped', () => {
  const { actors } = groupCredits([
    { name: 'Same Name', role: 'actor' },
    { name: 'Same Name', role: 'actor' },
    { name: 'Other', role: 'actor' },
    { name: '  ', role: 'actor' },
  ]);
  assert.deepEqual(
    actors.map((a) => a.name),
    ['Same Name', 'Other'],
  );
});

test('the input is left as it was', () => {
  const cast = [credit('X', 'actor', { character: 'One' }), credit('X', 'actor', { character: 'Two' })];
  groupCredits(cast);
  assert.equal(cast[0].character, 'One');
});

test('no credits, no groups', () => {
  assert.deepEqual(groupCredits(undefined), { actors: [], crew: [] });
  assert.deepEqual(groupCredits([]), { actors: [], crew: [] });
});

test('labels: singular for one name, plural for more, the fixed ones fixed', () => {
  assert.equal(creditLabel('director', 1), 'Director');
  assert.equal(creditLabel('director', 2), 'Directors');
  assert.equal(creditLabel('writer', 3), 'Writers');
  assert.equal(creditLabel('producer', 1), 'Producer');
  assert.equal(creditLabel('editor', 2), 'Editors');
  assert.equal(creditLabel('composer', 1), 'Music');
  assert.equal(creditLabel('composer', 2), 'Music');
  assert.equal(creditLabel('cinematographer', 2), 'Cinematography');
  assert.equal(creditLabel('creator', 2), 'Created by');
  assert.equal(creditLabel('actor', 5), 'Starring');
  // An unknown role is titleized and not pluralised: it can't be done right blind.
  assert.equal(creditLabel('casting', 2), 'Casting');
  // Object's own keys are role tokens like any other, not labels.
  assert.equal(creditLabel('constructor', 1), 'Constructor');
});

test('titleizeRole splits on hyphens, underscores and spaces', () => {
  assert.equal(titleizeRole('sound-designer'), 'Sound Designer');
  assert.equal(titleizeRole('visual_effects'), 'Visual Effects');
  assert.equal(titleizeRole('art  direction'), 'Art Direction');
  assert.equal(titleizeRole(''), '');
});

test('roleOf', () => {
  assert.equal(roleOf({}), 'actor');
  assert.equal(roleOf({ role: 'Composer' }), 'composer');
});

test('a person’s roles on a title are named once each, in the order given', () => {
  assert.equal(formatRoles(['director']), 'Director');
  assert.equal(formatRoles(['director', 'writer']), 'Director · Writer');
  assert.equal(formatRoles(['actor', 'composer', 'sound-designer']), 'Actor · Composer · Sound Designer');
  assert.equal(formatRoles(['writer', 'WRITER']), 'Writer');
  assert.equal(formatRoles(['', ' ']), '');
  assert.equal(formatRoles([]), '');
  assert.equal(formatRoles(undefined), '');
  assert.equal(roleName('cinematographer'), 'Cinematographer');
  assert.equal(roleName('creator'), 'Creator');
  assert.equal(roleName('constructor'), 'Constructor');
});
