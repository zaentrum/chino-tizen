// Deleting the signed-in person's account — the app stores ask every app that
// makes accounts to offer it. DELETE <api>/v1/me with the bearer in the
// Authorization header only: chino-api refuses one in the URL (a link someone
// could be sent). chino-api deletes what it keeps of the person — their watch
// progress, lists, likes and watch history — and their sign-in, all or
// nothing, and answers:
//
//   200          deleted: the app signs the account out and goes back to the start
//   409          refused (the last admin, an account the platform manages):
//                its `message` says why, for the person
//   501          not set up on this server: its administrator deletes accounts
//   502 / other  nothing deleted: try again later, with the server's `message`
//
// Every answer but 200 leaves the account signed in. Pure: account.test.ts
// runs it under node --test against a fake fetch.

export type AccountDeletion =
  | { kind: 'deleted' }
  | { kind: 'refused'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed'; message: string };

export const ACCOUNT_DELETION_UNAVAILABLE =
  "Deleting your account isn't available on this server — ask its administrator.";

/** The heading an answer is shown under: short, title case. */
export function accountDeletionTitle(answer: Exclude<AccountDeletion, { kind: 'deleted' }>): string {
  switch (answer.kind) {
    case 'refused':
      return 'Not Deleted';
    case 'unavailable':
      return 'Not Available';
    case 'failed':
      return 'Try Again Later';
  }
}

/** Asking again changes nothing: the server refused, or deletes no accounts. */
export function isFinal(answer: AccountDeletion): boolean {
  return answer.kind === 'refused' || answer.kind === 'unavailable';
}

/** What an answer means, from its status and the body's `message` (null when
 *  the body carried none a person can read). Only a 200 says the account is
 *  gone. */
export function accountDeletionAnswer(status: number, message: string | null): AccountDeletion {
  if (status === 200) return { kind: 'deleted' };
  if (status === 409) return { kind: 'refused', message: message ?? "This server won't delete your account." };
  if (status === 501) return { kind: 'unavailable', message: ACCOUNT_DELETION_UNAVAILABLE };
  if (status === 401) {
    return {
      kind: 'failed',
      message: message ?? 'This server no longer accepts your sign-in. Sign in again, then try once more.',
    };
  }
  return { kind: 'failed', message: message ?? `Your account couldn't be deleted right now (HTTP ${status}).` };
}

/** Longest server message shown: a sentence or two, not a page. */
const MAX_MESSAGE = 300;

/** The `message` of chino-api's JSON answer — written for the person — or
 *  null: an empty body, a proxy's page, a plain-text error. */
async function personMessage(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const message = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
    if (typeof message !== 'string' || !message.trim()) return null;
    return message.trim().slice(0, MAX_MESSAGE);
  } catch {
    return null;
  }
}

/**
 * Asks chino-api to delete the account [token] signs in. A 401 is retried
 * once with the token [renew] hands back (an access token that ran out while
 * the TV sat on the screen). Never throws: a request that does not reach the
 * server is a failure like any other.
 */
export async function deleteAccount(opts: {
  /** chino-api's account route: `<api base>/v1/me`. */
  url: string;
  /** The access token of the account to delete. */
  token: string | null;
  /** A fresh token for the same account after a 401, or null. */
  renew?: () => Promise<string | null>;
  /** For tests; the browser's fetch otherwise. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<AccountDeletion> {
  const doFetch = opts.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const send = (token: string) =>
    doFetch(opts.url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });

  let token = opts.token;
  if (!token && opts.renew) token = await opts.renew().catch(() => null);
  if (!token) return accountDeletionAnswer(401, null);
  try {
    let res = await send(token);
    if (res.status === 401 && opts.renew) {
      const renewed = await opts.renew().catch(() => null);
      if (renewed) res = await send(renewed);
    }
    if (res.status === 200) return { kind: 'deleted' };
    return accountDeletionAnswer(res.status, await personMessage(res));
  } catch {
    return { kind: 'failed', message: "The server couldn't be reached." };
  }
}
