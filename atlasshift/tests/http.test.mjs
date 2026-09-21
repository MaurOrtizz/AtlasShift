import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJSON } from '../src/http.ts';

test('HTTP failures reject instead of being treated as successful saves/deletes', async t => {
  for (const status of [404, 422, 500]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ detail: 'Not saved' }), { status }));
    await assert.rejects(requestJSON('/worlds/1', { method: 'PUT' }), new RegExp(`${status}.*Not saved`));
    await assert.rejects(requestJSON('/worlds/1', { method: 'DELETE' }), new RegExp(`${status}`));
  }
});

test('network errors and invalid responses are actionable', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(requestJSON('/worlds'), /Cannot reach/);
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>broken</html>'));
  await assert.rejects(requestJSON('/worlds'), /invalid response/);
  t.mock.method(globalThis, 'fetch', async () => new Response('gateway failure', { status: 502 }));
  await assert.rejects(requestJSON('/worlds'), /502/);
});

test('valid JSON and empty successful responses are accepted', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: 1, name: 'Saved' })));
  assert.deepEqual(await requestJSON('/worlds'), { id: 1, name: 'Saved' });
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  assert.equal(await requestJSON('/worlds/1', { method: 'DELETE' }), undefined);
});
