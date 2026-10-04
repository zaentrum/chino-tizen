// node --test (type stripping, Node >= 22.18): deleting an account against a
// fake chino-api, and what each answer means. Excluded from the app's tsc
// program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_DELETION_UNAVAILABLE,
  accountDeletionAnswer,
  accountDeletionTitle,
  deleteAccount,
  isFinal,
} from './account.ts';

const URL_ME = 'https://media.example.org/api/v1/me';

interface Sent {
  url: string;
  init: RequestInit;
}

/** A fake chino-api answering with [status] and [body] (JSON when an object,
 *  as writeJSON sends it; plain text when a string); a list answers request
 *  by request. Records what was sent. */
function fakeServer(...answers: { status: number; body?: object | string }[]) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const { status, body } = answers[Math.min(sent.length, answers.length - 1)];
    sent.push({ url, init });
    if (body === undefined) return new Response(null, { status });
    if (typeof body === 'string') {
      return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { sent, fetch };
}

const bearerOf = (s: Sent) => new Headers(s.init.headers).get('Authorization');

test('200: the account and its data are deleted', async () => {
  const deleted = fakeServer({ status: 200, body: { account: 'deleted', deleted: { progress: 12, likes: 4 } } });
  assert.deepEqual(await deleteAccount({ url: URL_ME, token: 't', fetch: deleted.fetch }), { kind: 'deleted' });
  // The account was gone already: now its data is too.
  const gone = fakeServer({ status: 200, body: { account: 'gone', deleted: {} } });
  assert.deepEqual(await deleteAccount({ url: URL_ME, token: 't', fetch: gone.fetch }), { kind: 'deleted' });
});

test('the request: DELETE <api>/v1/me, the bearer in the header and never in the URL', async () => {
  const server = fakeServer({ status: 200, body: { account: 'deleted' } });
  await deleteAccount({ url: URL_ME, token: 'tok-secret', fetch: server.fetch });

  assert.equal(server.sent.length, 1);
  const [sent] = server.sent;
  assert.equal(sent.url, URL_ME);
  assert.equal(sent.init.method, 'DELETE');
  assert.equal(bearerOf(sent), 'Bearer tok-secret');
  assert.equal(sent.url.includes('tok-secret'), false);
  assert.equal(sent.url.includes('?'), false);
});

test("409: refused, in the server's words", async () => {
  const server = fakeServer({
    status: 409,
    body: { error: 'refused', message: 'You are the last admin of this server: make someone else an admin first.' },
  });
  const refused = await deleteAccount({ url: URL_ME, token: 't', fetch: server.fetch });
  assert.deepEqual(refused, {
    kind: 'refused',
    message: 'You are the last admin of this server: make someone else an admin first.',
  });
  assert.equal(isFinal(refused), true);
  assert.equal(refused.kind !== 'deleted' && accountDeletionTitle(refused), 'Not Deleted');
  // No message to show: still a refusal, said plainly.
  const bare = fakeServer({ status: 409 });
  assert.deepEqual(await deleteAccount({ url: URL_ME, token: 't', fetch: bare.fetch }), {
    kind: 'refused',
    message: "This server won't delete your account.",
  });
});

test('501: not available on this server, whatever the body says', async () => {
  const server = fakeServer({
    status: 501,
    body: { error: 'account_deletion_unavailable', message: 'Accounts are not deleted from the apps on this server: ask whoever runs it.' },
  });
  const unavailable = await deleteAccount({ url: URL_ME, token: 't', fetch: server.fetch });
  assert.deepEqual(unavailable, { kind: 'unavailable', message: ACCOUNT_DELETION_UNAVAILABLE });
  assert.equal(ACCOUNT_DELETION_UNAVAILABLE, "Deleting your account isn't available on this server — ask its administrator.");
  assert.equal(isFinal(unavailable), true);
});

test("502: nothing deleted - try again later, with the server's message", async () => {
  const server = fakeServer({
    status: 502,
    body: { error: 'account_not_deleted', message: 'Your account could not be deleted right now, so nothing was. Try again later.' },
  });
  const failed = await deleteAccount({ url: URL_ME, token: 't', fetch: server.fetch });
  assert.deepEqual(failed, {
    kind: 'failed',
    message: 'Your account could not be deleted right now, so nothing was. Try again later.',
  });
  assert.equal(failed.kind !== 'deleted' && accountDeletionTitle(failed), 'Try Again Later');
  assert.equal(isFinal(failed), false);
});

test('any other answer is a failure too, and only a JSON message is shown', async () => {
  const dataNotDeleted = fakeServer({
    status: 500,
    body: { error: 'data_not_deleted', message: 'Your data could not be deleted, so nothing was. Try again later.' },
  });
  assert.deepEqual(await deleteAccount({ url: URL_ME, token: 't', fetch: dataNotDeleted.fetch }), {
    kind: 'failed',
    message: 'Your data could not be deleted, so nothing was. Try again later.',
  });
  // A proxy's page, a plain-text error: no server words.
  const proxy = fakeServer({ status: 502, body: '<html><body>502 Bad Gateway</body></html>' });
  assert.deepEqual(await deleteAccount({ url: URL_ME, token: 't', fetch: proxy.fetch }), {
    kind: 'failed',
    message: "Your account couldn't be deleted right now (HTTP 502).",
  });
  const plain = fakeServer({ status: 503, body: 'upstream connect error\n' });
  assert.deepEqual(await deleteAccount({ url: URL_ME, token: 't', fetch: plain.fetch }), {
    kind: 'failed',
    message: "Your account couldn't be deleted right now (HTTP 503).",
  });
});

test('a 401 is asked again once, with the renewed token', async () => {
  const server = fakeServer({ status: 401, body: 'token expired\n' }, { status: 200, body: { account: 'deleted' } });
  const answer = await deleteAccount({
    url: URL_ME,
    token: 'tok-old',
    renew: async () => 'tok-new',
    fetch: server.fetch,
  });
  assert.deepEqual(answer, { kind: 'deleted' });
  assert.deepEqual(server.sent.map(bearerOf), ['Bearer tok-old', 'Bearer tok-new']);
});

test('a sign-in that cannot be renewed is a failure, sent once', async () => {
  const server = fakeServer({ status: 401, body: 'token expired\n' });
  const answer = await deleteAccount({ url: URL_ME, token: 'tok-old', renew: async () => null, fetch: server.fetch });
  assert.deepEqual(answer, {
    kind: 'failed',
    message: 'This server no longer accepts your sign-in. Sign in again, then try once more.',
  });
  assert.equal(server.sent.length, 1);
  // No token at all, and none to be had: nothing is sent.
  const none = fakeServer({ status: 200 });
  assert.equal((await deleteAccount({ url: URL_ME, token: null, renew: async () => null, fetch: none.fetch })).kind, 'failed');
  assert.equal(none.sent.length, 0);
});

test('only a 200 signs out: another 2xx is no proof the account is gone', () => {
  for (const status of [201, 202, 204]) {
    assert.equal(accountDeletionAnswer(status, null).kind, 'failed', String(status));
  }
});

test('a request that never reaches the server is a failure, not a throw', async () => {
  const offline = async (): Promise<Response> => {
    throw new TypeError('Failed to fetch');
  };
  assert.deepEqual(await deleteAccount({ url: URL_ME, token: 't', fetch: offline }), {
    kind: 'failed',
    message: "The server couldn't be reached.",
  });
});

test('a long server message is cut to a few sentences', async () => {
  const server = fakeServer({ status: 409, body: { error: 'refused', message: 'x'.repeat(1000) } });
  const answer = await deleteAccount({ url: URL_ME, token: 't', fetch: server.fetch });
  assert.equal(answer.kind === 'refused' && answer.message.length, 300);
});
