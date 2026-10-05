// node --test (type stripping, Node >= 22.18): which slot rows the TV shows,
// resolved on the server's origin, and how an action is sent. Excluded from
// the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_ICON_NAMES,
  sendSlotAction,
  serverOrigin,
  slotActionUrl,
  slotButtons,
  slotIconName,
  slotKind,
  slotLinkHref,
  substitute,
} from './extensions.ts';

const ORIGIN = 'https://media.example.org';

test("the server's origin comes from its API base", () => {
  assert.equal(serverOrigin('https://media.example.org/api'), ORIGIN);
  assert.equal(serverOrigin('https://example.com/media/api'), 'https://example.com');
  assert.equal(serverOrigin('http://192.0.2.10:8080/api'), 'http://192.0.2.10:8080');
  assert.equal(serverOrigin('HTTPS://MEDIA.EXAMPLE.ORG:443/api'), ORIGIN);
  for (const raw of [undefined, null, '', '/api', 'media.example.org/api', 'ftp://media.example.org/api']) {
    assert.equal(serverOrigin(raw), null, String(raw));
  }
});

test('a link on the server itself: a path there, or absolute on its origin', () => {
  assert.equal(slotLinkHref('/portal/app/example?q=zz', ORIGIN), 'https://media.example.org/portal/app/example?q=zz');
  assert.equal(slotLinkHref('  /portal/app/example  ', ORIGIN), 'https://media.example.org/portal/app/example');
  assert.equal(slotLinkHref('https://media.example.org/portal/app/example', ORIGIN), 'https://media.example.org/portal/app/example');
  assert.equal(slotLinkHref('HTTPS://MEDIA.EXAMPLE.ORG/x#/y', ORIGIN), 'https://media.example.org/x#/y');
  // The default port is the same origin.
  assert.equal(slotLinkHref('https://media.example.org:443/portal/', ORIGIN), 'https://media.example.org/portal/');
  // A path climbing out of where it says it goes is resolved before anything opens it.
  assert.equal(slotLinkHref('/portal/app/example/../../x', ORIGIN), 'https://media.example.org/portal/x');
});

test('the app has no page for a relative URL to mean', () => {
  for (const raw of ['?q=other', '#/x', 'portal/app/example', './x', '../x']) {
    assert.equal(slotLinkHref(raw, ORIGIN), null, raw);
  }
});

test('a script URL shows nothing, however it is spelled', () => {
  for (const raw of [
    'javascript:void(document.title="x")',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
  ]) {
    assert.equal(slotLinkHref(raw, ORIGIN), null, raw);
  }
});

test('another origin shows nothing: another host, scheme or port, protocol-relative, credentials', () => {
  for (const raw of [
    'https://elsewhere.example.com/landing',
    'https://media.example.org.elsewhere.example.com/x',
    '//elsewhere.example.com/landing',
    '//media.example.org/landing',
    '/\\elsewhere.example.com/landing',
    '\\\\elsewhere.example.com/landing',
    'http://media.example.org/portal/',
    'https://media.example.org:8443/portal/',
    'https://user:secret@media.example.org/portal/',
    'ftp://media.example.org/file',
    'mailto:someone@media.example.org',
  ]) {
    assert.equal(slotLinkHref(raw, ORIGIN), null, raw);
  }
});

test('no URL, an empty one, or not a string at all: nothing', () => {
  for (const raw of [undefined, null, '', '   ', 42, {}, ['/x']]) {
    assert.equal(slotLinkHref(raw, ORIGIN), null, String(raw));
  }
});

test('{q} is substituted encoded, after the form of the URL is checked', () => {
  assert.equal(
    slotLinkHref('/portal/app/example?q={q}', ORIGIN, { q: 'zz&qq=1 <x> "y"#w' }),
    'https://media.example.org/portal/app/example?q=zz%26qq%3D1%20%3Cx%3E%20%22y%22%23w',
  );
  // A query cannot turn a row into a script, another host or another path.
  assert.equal(slotLinkHref('{q}', ORIGIN, { q: 'javascript:alert(1)' }), null);
  assert.equal(slotLinkHref('{q}', ORIGIN, { q: '/portal/app/example' }), null);
  assert.equal(slotLinkHref('https://{q}/x', ORIGIN, { q: 'elsewhere.example.com' }), null);
  assert.equal(slotLinkHref('/{q}', ORIGIN, { q: '/elsewhere.example.com' }), 'https://media.example.org/%2Felsewhere.example.com');
  assert.equal(substitute('/x?a={a}&b={b}', { a: '1 2' }), '/x?a=1%202&b=');
  // Only own properties: {constructor} is not a var.
  assert.equal(substitute('/x?c={constructor}', {}), '/x?c=');
});

test("an action POSTs only to the portal's app proxy on the server's origin", () => {
  assert.equal(
    slotActionUrl('/api/portal/apps/example/collect?q={q}', 'POST', ORIGIN, { q: 'a b' }),
    'https://media.example.org/api/portal/apps/example/collect?q=a%20b',
  );
  assert.equal(
    slotActionUrl('https://media.example.org/api/portal/apps/example', '', ORIGIN),
    'https://media.example.org/api/portal/apps/example',
  );
  // No method means POST; the case does not matter.
  assert.equal(slotActionUrl('/api/portal/apps/example/x', undefined, ORIGIN), 'https://media.example.org/api/portal/apps/example/x');
  assert.equal(slotActionUrl('/api/portal/apps/example/x', null, ORIGIN), 'https://media.example.org/api/portal/apps/example/x');
  assert.equal(slotActionUrl('/api/portal/apps/example/x', 'post', ORIGIN), 'https://media.example.org/api/portal/apps/example/x');
});

test('an action with any other method shows nothing', () => {
  for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'post ; DELETE', 7]) {
    assert.equal(slotActionUrl('/api/portal/apps/example/x', method, ORIGIN), null, String(method));
  }
});

test('the bearer never leaves the origin, nor goes to chino-api or the portal itself', () => {
  for (const raw of [
    'https://elsewhere.example.com/collect',
    '//elsewhere.example.com/api/portal/apps/example/x',
    'http://media.example.org/api/portal/apps/example/x',
    '/api/v1/me/watchlists',
    '/api/v1/notices/read-all',
    '/api/portal/addons/example',
    '/api/portal/me/notices',
    '/portal/app/example',
    '/api/portal/apps/',
    '/api/portal/apps//x',
    // Climbing out of the proxy, plainly or encoded, is resolved before the check.
    '/api/portal/apps/example/../../addons/example',
    '/api/portal/apps/example/%2e%2e/%2e%2e/addons',
    '/api/portal/apps/example/..%2f..%2faddons',
    '/api/portal/apps/example%5c..%5c..%5caddons',
    'javascript:fetch("/api/portal/apps/example/x")',
  ]) {
    assert.equal(slotActionUrl(raw, 'POST', ORIGIN), null, raw);
  }
  // A query cannot climb out either: a separator it carries is encoded.
  assert.equal(slotActionUrl('/api/portal/apps/{q}', 'POST', ORIGIN, { q: 'example/../../addons' }), null);
});

test('only links and actions are kinds', () => {
  assert.equal(slotKind('link'), 'link');
  assert.equal(slotKind(' Action '), 'action');
  for (const raw of ['iframe', 'script', '', undefined, null, 1]) assert.equal(slotKind(raw), null, String(raw));
});

test('slotButtons: the rows that show, in order, and what is left of the rest', () => {
  const rows = [
    { key: 'example.open', kind: 'link', label: 'Open Example', icon: 'list-video', url: '/portal/app/example?q={q}#/find', enabled: true },
    { key: 'example.js', kind: 'link', label: 'javascript: link', icon: 'zap', url: 'javascript:void(document.title="x")', enabled: true },
    { key: 'example.offorigin', kind: 'action', label: 'action to another origin', url: 'https://elsewhere.example.com/collect?q={q}', method: 'DELETE', enabled: true },
    { key: 'example.iframe', kind: 'iframe', label: 'kind iframe', icon: 'frame', url: '/api/portal/apps/example/frame', enabled: true },
    { key: 'example.offsite', kind: 'link', label: 'off-site link', icon: 'puzzle', url: 'https://elsewhere.example.com/landing', enabled: true },
    { key: 'example.tell', kind: 'action', label: 'Tell Example', icon: 'radar', url: '/api/portal/apps/example/tell?q={q}', method: 'POST', enabled: true },
    { key: 'example.off', kind: 'link', label: 'disabled', url: '/portal/app/example', enabled: false },
    { key: 'example.nolabel', kind: 'link', label: '  ', url: '/portal/app/example', enabled: true },
    { kind: 'link', label: 'No Key', url: '/portal/app/example', enabled: true },
    null,
    'not a row',
  ];
  assert.deepEqual(slotButtons(rows, ORIGIN, { q: 'zz top' }), [
    { key: 'example.open', kind: 'link', label: 'Open Example', icon: 'list-video', href: 'https://media.example.org/portal/app/example?q=zz%20top#/find' },
    { key: 'example.tell', kind: 'action', label: 'Tell Example', icon: 'radar', href: 'https://media.example.org/api/portal/apps/example/tell?q=zz%20top' },
    { key: 'row-8', kind: 'link', label: 'No Key', icon: 'puzzle', href: 'https://media.example.org/portal/app/example' },
  ]);
  assert.deepEqual(slotButtons({ not: 'an array' }, ORIGIN), []);
  assert.deepEqual(slotButtons(undefined, ORIGIN), []);
  // No server to hold the rows to: nothing shows.
  assert.deepEqual(slotButtons(rows, null, { q: 'zz' }), []);
});

test("icons: the palette's names, as the portal stores them or as lucide spells them", () => {
  for (const name of SLOT_ICON_NAMES) assert.equal(slotIconName(name), name);
  assert.equal(slotIconName('ListVideo'), 'list-video');
  assert.equal(slotIconName('layoutGrid'), 'layout-grid');
  assert.equal(slotIconName(' FileText '), 'file-text');
  assert.equal(slotIconName('Puzzle'), 'puzzle');
  assert.equal(slotIconName('TV'), 'tv');
});

test('icons: any other name is the puzzle', () => {
  for (const raw of ['icon', 'Icon', 'createLucideIcon', 'rocket', 'zap', 'glyph:c', '', undefined, null, 3, {}]) {
    assert.equal(slotIconName(raw), 'puzzle', String(raw));
  }
});

interface Sent {
  url: string;
  init: RequestInit;
}

/** A fake server answering every call with [status]; records what was sent. */
function fakeServer(status: number) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    sent.push({ url, init });
    return new Response(status === 204 ? null : '{}', { status });
  };
  return { sent, fetch };
}

const HREF = 'https://media.example.org/api/portal/apps/example/tell?q=zz';

test('an action is a POST with the bearer in the header, no body, and no redirect followed', async () => {
  const server = fakeServer(202);
  assert.equal(await sendSlotAction({ href: HREF, token: 'tok-secret', fetch: server.fetch }), 'sent');
  assert.equal(server.sent.length, 1);
  const [sent] = server.sent;
  assert.equal(sent.url, HREF);
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.redirect, 'error');
  assert.equal(sent.init.body, undefined);
  assert.equal(new Headers(sent.init.headers).get('Authorization'), 'Bearer tok-secret');
  assert.equal(sent.url.includes('tok-secret'), false);
  assert.equal(await sendSlotAction({ href: HREF, token: 't', fetch: fakeServer(204).fetch }), 'sent');
});

test('an action the addon did not take, or that never got there, failed; without a token nothing is sent', async () => {
  for (const status of [400, 401, 403, 404, 500, 502]) {
    assert.equal(await sendSlotAction({ href: HREF, token: 't', fetch: fakeServer(status).fetch }), 'failed', String(status));
  }
  const offline = async (): Promise<Response> => {
    throw new TypeError('Failed to fetch');
  };
  assert.equal(await sendSlotAction({ href: HREF, token: 't', fetch: offline }), 'failed');
  const none = fakeServer(200);
  assert.equal(await sendSlotAction({ href: HREF, token: null, fetch: none.fetch }), 'failed');
  assert.equal(none.sent.length, 0);
});
