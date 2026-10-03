// node --test (type stripping, Node >= 22.18): asset URLs against the
// configured server. Excluded from the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl, withStreamToken } from './artwork.ts';

test('an /api path is re-rooted on the API base, not appended to it', () => {
  assert.equal(
    apiUrl('https://media.example.com/api', '/api/v1/items/m1/poster'),
    'https://media.example.com/api/v1/items/m1/poster',
  );
  assert.equal(
    apiUrl('https://media.example.com/api/', '/api/v1/people/p1/profile'),
    'https://media.example.com/api/v1/people/p1/profile',
  );
});

test('a server behind a path prefix keeps its prefix', () => {
  assert.equal(
    apiUrl('https://example.com/media/api', '/api/v1/play/subs/s1.vtt'),
    'https://example.com/media/api/v1/play/subs/s1.vtt',
  );
});

test('paths relative to the API root and absolute URLs', () => {
  assert.equal(apiUrl('https://h/api', '/v1/items/m1/backdrop'), 'https://h/api/v1/items/m1/backdrop');
  assert.equal(apiUrl('https://h/api', 'v1/items/m1/backdrop'), 'https://h/api/v1/items/m1/backdrop');
  assert.equal(apiUrl('https://h/api', 'https://cdn.example.com/p.jpg'), 'https://cdn.example.com/p.jpg');
  assert.equal(apiUrl('https://h/api', undefined), undefined);
  assert.equal(apiUrl('', '/api/v1/items/m1/poster'), '/api/v1/items/m1/poster');
});

test('the stream token rides along as ?stream=, encoded', () => {
  assert.equal(withStreamToken('https://h/api/v1/items/m1/poster', 'a+b/c'), 'https://h/api/v1/items/m1/poster?stream=a%2Bb%2Fc');
  assert.equal(withStreamToken('https://h/x?q=1', 't'), 'https://h/x?q=1&stream=t');
  assert.equal(withStreamToken('https://h/x', ''), 'https://h/x');
  assert.equal(withStreamToken(undefined, 't'), undefined);
});
