import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fetchCalls, listEndedCallIds, retellClientOptions, RetellError } from './retell-client.js';
import type { RetellClientOptions } from './retell-client.js';

// An in-memory stand-in for the Retell API, plugged in as `fetchImpl`. No
// sockets: the client is exercised end to end and the test cannot be broken by
// a sandbox that forbids localhost.

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  auth: string | null;
}

type Handler = (seen: Seen, hit: number) => { status: number; json?: unknown; headers?: Record<string, string> };

function fake(handler: Handler): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const entry: Seen = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      auth: new Headers(init?.headers).get('authorization'),
    };
    seen.push(entry);
    const hit = seen.filter((s) => s.path === entry.path).length;
    const out = handler(entry, hit);
    return new Response(out.json === undefined ? '' : JSON.stringify(out.json), {
      status: out.status,
      headers: out.headers ?? {},
    });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function client(fetchImpl: typeof fetch, overrides: Partial<RetellClientOptions> = {}): RetellClientOptions {
  const slept: number[] = [];
  return retellClientOptions('key_test', {
    baseUrl: 'https://retell.test',
    fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...overrides,
  });
}

const WINDOW = { fromMs: 1000, toMs: 2000, agentIds: [], maxCalls: 2000 };

describe('listing calls', () => {
  it('follows the cursor, sends the time window, and keeps only ended calls', async () => {
    const { fetchImpl, seen } = fake((s) =>
      s.body?.['pagination_key'] === 'page2'
        ? { status: 200, json: { items: [{ call_id: 'c3', call_status: 'ended' }], has_more: false } }
        : {
            status: 200,
            json: {
              items: [
                { call_id: 'c1', call_status: 'ended' },
                { call_id: 'live', call_status: 'ongoing' },
                { call_id: 'c2', call_status: 'ended' },
              ],
              has_more: true,
              pagination_key: 'page2',
            },
          },
    );
    const listed = await listEndedCallIds(client(fetchImpl), { ...WINDOW, agentIds: ['agent_1'] });

    assert.deepEqual(listed, { ids: ['c1', 'c2', 'c3'], truncated: false });
    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.method, 'POST');
    assert.equal(seen[0]?.path, '/v3/list-calls');
    assert.equal(seen[0]?.auth, 'Bearer key_test');
    assert.deepEqual(seen[0]?.body?.['filter_criteria'], {
      start_timestamp: { op: 'bt', value: [1000, 2000] },
      agent: [{ agent_id: 'agent_1' }],
    });
    assert.equal(seen[1]?.body?.['pagination_key'], 'page2');
  });

  it('stops at --max-calls and says the window was cut short', async () => {
    const { fetchImpl } = fake(() => ({
      status: 200,
      json: { items: [{ call_id: 'c1' }, { call_id: 'c2' }, { call_id: 'c3' }], has_more: true, pagination_key: 'k' },
    }));
    assert.deepEqual(await listEndedCallIds(client(fetchImpl), { ...WINDOW, maxCalls: 2 }), {
      ids: ['c1', 'c2'],
      truncated: true,
    });
  });

  it('does not loop on a cursor that repeats', async () => {
    const { fetchImpl, seen } = fake(() => ({
      status: 200,
      json: { items: [{ call_id: 'c1' }], has_more: true, pagination_key: 'same' },
    }));
    const listed = await listEndedCallIds(client(fetchImpl), WINDOW);
    assert.equal(seen.length, 2);
    assert.equal(listed.ids.length, 2);
  });

  it('retries a 429 and a 5xx, because a repeated read creates nothing', async () => {
    const { fetchImpl, seen } = fake((_s, hit) =>
      hit === 1
        ? { status: 429, headers: { 'retry-after': '0' } }
        : hit === 2
          ? { status: 503 }
          : { status: 200, json: { items: [{ call_id: 'c1' }], has_more: false } },
    );
    assert.deepEqual((await listEndedCallIds(client(fetchImpl), WINDOW)).ids, ['c1']);
    assert.equal(seen.length, 3);
  });

  it('gives up after the retry budget with a plain message', async () => {
    const { fetchImpl, seen } = fake(() => ({ status: 503 }));
    await assert.rejects(listEndedCallIds(client(fetchImpl, { maxRetries: 2 }), WINDOW), (err: unknown) => {
      assert.ok(err instanceof RetellError);
      assert.match(err.message, /kept answering HTTP 503 after 3 tries/);
      return true;
    });
    assert.equal(seen.length, 3);
  });

  it('does not retry a rejected key', async () => {
    const { fetchImpl, seen } = fake(() => ({ status: 401, json: { message: 'nope' } }));
    await assert.rejects(listEndedCallIds(client(fetchImpl), WINDOW), /rejected the API key \(HTTP 401\)/);
    assert.equal(seen.length, 1);
  });
});

describe('fetching call logs', () => {
  it('reads each call from /v2 and keeps the order it was asked for', async () => {
    const { fetchImpl, seen } = fake((s) => ({ status: 200, json: { call_id: s.path.split('/').pop() } }));
    const fetched = await fetchCalls(client(fetchImpl), ['c1', 'c2', 'c3']);
    assert.deepEqual(fetched.calls, [{ call_id: 'c1' }, { call_id: 'c2' }, { call_id: 'c3' }]);
    assert.equal(fetched.detailVersion, 'v2');
    assert.ok(seen.every((s) => s.method === 'GET' && s.path.startsWith('/v2/get-call/')));
  });

  it('falls back to /v1 when /v2 is not there, and remembers', async () => {
    const { fetchImpl, seen } = fake((s) =>
      s.path.startsWith('/v2/') ? { status: 404 } : { status: 200, json: { call_id: s.path.split('/').pop() } },
    );
    const fetched = await fetchCalls(client(fetchImpl, { concurrency: 1 }), ['c1', 'c2']);
    assert.equal(fetched.calls.length, 2);
    assert.equal(fetched.detailVersion, 'v1');
    assert.deepEqual(
      seen.map((s) => s.path),
      ['/v2/get-call/c1', '/v1/get-call/c1', '/v1/get-call/c2'],
    );
  });

  it('reports a call it could not fetch and carries on', async () => {
    const { fetchImpl } = fake((s) =>
      s.path.endsWith('/gone') ? { status: 404 } : { status: 200, json: { call_id: s.path.split('/').pop() } },
    );
    const fetched = await fetchCalls(client(fetchImpl), ['c1', 'gone', 'c3']);
    assert.deepEqual(fetched.calls, [{ call_id: 'c1' }, { call_id: 'c3' }]);
    assert.deepEqual(fetched.failed, ['gone']);
  });

  it('stops on a rejected key rather than failing every call', async () => {
    const { fetchImpl, seen } = fake(() => ({ status: 403 }));
    await assert.rejects(fetchCalls(client(fetchImpl, { concurrency: 1 }), ['c1', 'c2', 'c3']), RetellError);
    assert.equal(seen.length, 1);
  });

  it('a rerun reads from the cache and asks the API for nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'booking-audit-cache-'));
    try {
      const first = fake((s) => ({ status: 200, json: { call_id: s.path.split('/').pop() } }));
      await fetchCalls(client(first.fetchImpl, { cacheDir: dir }), ['c1', 'c2']);
      assert.deepEqual((await readdir(dir)).sort(), ['c1.json', 'c2.json']);

      const second = fake(() => ({ status: 500 }));
      const again = await fetchCalls(client(second.fetchImpl, { cacheDir: dir }), ['c1', 'c2']);
      assert.equal(second.seen.length, 0);
      assert.equal(again.fromCache, 2);
      assert.deepEqual(again.calls, [{ call_id: 'c1' }, { call_id: 'c2' }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never turns a call id from the network into a path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'booking-audit-cache-'));
    try {
      const { fetchImpl, seen } = fake(() => ({ status: 200, json: { call_id: 'x' } }));
      const fetched = await fetchCalls(client(fetchImpl, { cacheDir: dir }), ['../../escape']);
      assert.equal(fetched.calls.length, 1);
      assert.equal(seen[0]?.path, '/v2/get-call/..%2F..%2Fescape');
      assert.deepEqual(await readdir(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
