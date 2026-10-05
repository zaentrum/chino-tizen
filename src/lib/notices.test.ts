// node --test (type stripping, Node >= 22.18): reading what chino-api
// answers for the signed-in person's notices, and the list after each
// change. Excluded from the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageText,
  badgeText,
  bellLabel,
  focusAfterRemoval,
  fromText,
  markAllRead,
  markRead,
  noticeItemRoute,
  noticeListOf,
  plainText,
  removeNotice,
  type Notice,
  type NoticeList,
} from './notices.ts';

const now = Date.parse('2026-10-05T08:00:00Z');

const notice = (over: Partial<Notice> = {}): Notice => ({
  id: '00000001-0000-4000-8000-000000000001',
  addon: 'example',
  addonTitle: 'Example',
  addonIcon: 'puzzle',
  title: 'Your title is ready',
  body: 'It is in your library now.',
  link: '',
  itemId: '',
  createdAt: '2026-10-05T07:58:00Z',
  readAt: null,
  ...over,
});

// What chino-api answers is read as it came: a notice without an id or a
// title is none, a missing field is empty, and the unread count holds the
// unread notices listed.
test('a list is read defensively', () => {
  const got = noticeListOf({
    notices: [
      notice(),
      { id: 'x' },
      { title: 'no id' },
      null,
      'a string',
      { id: 'y', title: 'bare', readAt: '2026-10-05T07:59:00Z', link: 7 },
    ],
    unread: 1,
    available: true,
  });
  assert.equal(got.available, true);
  assert.equal(got.notices.length, 2);
  assert.equal(got.notices[1].link, '');
  assert.equal(got.notices[1].body, '');
  assert.equal(got.notices[1].readAt, '2026-10-05T07:59:00Z');
  assert.equal(got.notices[1].addonTitle, '');
  assert.equal(got.unread, 1);
  assert.deepEqual(noticeListOf({ notices: 'no', available: true }), { notices: [], unread: 0, available: true });
  // An unread count below what is listed unread is not believed.
  assert.equal(noticeListOf({ notices: [notice(), notice({ id: 'b' })], unread: 0, available: true }).unread, 2);
  assert.equal(noticeListOf({ notices: [notice()], unread: -3, available: true }).unread, 1);
  assert.equal(noticeListOf({ notices: [notice()], unread: 1.5, available: true }).unread, 1);
  assert.equal(noticeListOf({ notices: [], unread: 7, available: true }).unread, 7);
  // One id listed twice is one notice.
  assert.equal(noticeListOf({ notices: [notice(), notice({ title: 'again' })], available: true }).notices.length, 1);
});

// available false: no portal-api answered, so there is nothing to show —
// whatever else the answer holds — and nothing to count.
test('a list that is not available shows nothing', () => {
  const none = { notices: [], unread: 0, available: false };
  assert.deepEqual(noticeListOf({ notices: [], unread: 0, available: false }), none);
  assert.deepEqual(noticeListOf({ notices: [notice()], unread: 1, available: false }), none);
  assert.deepEqual(noticeListOf({ notices: [notice()], unread: 1 }), none);
  assert.deepEqual(noticeListOf({ notices: [notice()], unread: 1, available: 'true' }), none);
  assert.deepEqual(noticeListOf(null), none);
  assert.deepEqual(noticeListOf('<html>502 Bad Gateway</html>'), none);
});

// The addon's words are plain text: shown as they are, markup and all, its
// line breaks kept — and what portal-api refuses is checked again.
test("a notice's text is the addon's plain text", () => {
  assert.equal(plainText('Line one\nLine two\n\nLine four', true), 'Line one\nLine two\n\nLine four');
  assert.equal(plainText('Line one\r\nLine two\rLine three', true), 'Line one\nLine two\nLine three');
  assert.equal(plainText('<b>bold</b> &amp; <script>x()</script>', true), '<b>bold</b> &amp; <script>x()</script>');
  assert.equal(plainText('a\u0000b\u0007c\u001bd\u007fe\u0085f', true), 'abcdef');
  assert.equal(plainText('tab\tseparated', true), 'tab separated');
  // The characters that turn text around, which would let a title read as
  // something it is not.
  assert.equal(plainText('ready ‮evil‬ ⁦x⁩', false), 'ready evil x');
  assert.equal(plainText('A title\nover two lines', false), 'A title over two lines');
  assert.equal(plainText('  padded  \n', true), 'padded');
  const got = noticeListOf({
    notices: [notice({ title: 'Ready\n‮now', body: 'One\r\nTwo\u0007' })],
    available: true,
  });
  assert.equal(got.notices[0].title, 'Ready now');
  assert.equal(got.notices[0].body, 'One\nTwo');
  // A title that is nothing once its control characters are gone is none.
  assert.equal(noticeListOf({ notices: [notice({ title: '\u0000‮' })], available: true }).notices.length, 0);
});

test('the bell says how many are unread', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(-1), '');
  assert.equal(badgeText(Number.NaN), '');
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
  assert.equal(bellLabel(0), 'Notices');
  assert.equal(bellLabel(3), 'Notices, 3 unread');
});

test('a notice says whom it is from and when', () => {
  assert.equal(fromText(notice()), 'Example');
  assert.equal(fromText(notice({ addonTitle: '  ' })), 'example');
  assert.equal(fromText(notice({ addonTitle: '', addon: '' })), 'An addon');
  assert.equal(ageText('2026-10-05T07:59:30Z', now), 'now');
  assert.equal(ageText('2026-10-05T08:00:30Z', now), 'now', "a clock a little ahead of the TV's");
  assert.equal(ageText('2026-10-05T07:55:00Z', now), '5m');
  assert.equal(ageText('2026-10-05T05:00:00Z', now), '3h');
  assert.equal(ageText('2026-10-03T08:00:00Z', now), '2d');
  // From a week on, the date where the TV is: these are midday there,
  // wherever the tests run.
  assert.equal(ageText(new Date(2026, 8, 12, 12).toISOString(), now), '12 Sep');
  assert.equal(ageText(new Date(2025, 11, 30, 12).toISOString(), now), '30 Dec 2025');
  assert.equal(ageText('not a time', now), '');
  assert.equal(ageText('', now), '');
});

test('an itemId opens the detail screen; anything else opens nothing', () => {
  assert.equal(noticeItemRoute(notice({ itemId: 'm1' })), '/detail/m1');
  assert.equal(noticeItemRoute(notice({ itemId: ' tt0111161 ' })), '/detail/tt0111161');
  assert.equal(noticeItemRoute(notice({ itemId: 'tmdb:603' })), '/detail/tmdb%3A603');
  assert.equal(noticeItemRoute(notice({ itemId: 'a.b_c-d' })), '/detail/a.b_c-d');
  assert.equal(noticeItemRoute(notice({ itemId: 'x'.repeat(128) })), `/detail/${'x'.repeat(128)}`);
  for (const itemId of ['', '   ', '../settings', 'a/b', 'a b', 'a?b', '%2e%2e', 'x'.repeat(129)]) {
    assert.equal(noticeItemRoute(notice({ itemId })), null, itemId);
  }
});

test('reading, reading all and deleting keep the count', () => {
  const list: NoticeList = {
    notices: [notice({ id: 'a' }), notice({ id: 'b' }), notice({ id: 'c', readAt: '2026-10-05T07:00:00Z' })],
    unread: 2,
    available: true,
  };
  const read = markRead(list, 'a', '2026-10-05T08:00:00Z');
  assert.equal(read.unread, 1);
  assert.equal(read.available, true);
  assert.equal(read.notices[0].readAt, '2026-10-05T08:00:00Z');
  assert.equal(list.notices[0].readAt, null, 'the list it was given stays as it was');
  assert.equal(markRead(read, 'a', 'later').unread, 1, 'reading again changes nothing');
  assert.equal(markRead(read, 'c', 'later').notices[2].readAt, '2026-10-05T07:00:00Z');
  assert.equal(markRead(list, 'none', 'later').unread, 2);
  const all = markAllRead(list, 'now');
  assert.equal(all.unread, 0);
  assert.equal(all.available, true);
  assert.ok(all.notices.every((n) => n.readAt !== null));
  assert.equal(all.notices[2].readAt, '2026-10-05T07:00:00Z');
  assert.deepEqual(removeNotice(list, 'b').notices.map((n) => n.id), ['a', 'c']);
  assert.equal(removeNotice(list, 'b').unread, 1);
  assert.equal(removeNotice(list, 'b').available, true);
  assert.equal(removeNotice(list, 'c').unread, 2, 'a read one takes nothing off the count');
  assert.equal(removeNotice({ notices: [notice({ id: 'a' })], unread: 0, available: true }, 'a').unread, 0);
});

test('after a delete, focus moves to the next notice, else the one before', () => {
  const list: NoticeList = {
    notices: [notice({ id: 'a' }), notice({ id: 'b' }), notice({ id: 'c' })],
    unread: 3,
    available: true,
  };
  assert.equal(focusAfterRemoval(list, 'a'), 'b');
  assert.equal(focusAfterRemoval(list, 'b'), 'c');
  assert.equal(focusAfterRemoval(list, 'c'), 'b');
  assert.equal(focusAfterRemoval({ ...list, notices: [notice({ id: 'a' })] }, 'a'), null);
  assert.equal(focusAfterRemoval(list, 'none'), null);
});
