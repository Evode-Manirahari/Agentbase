// Pure unit tests for ApolloConnector — no DB, no network.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ApolloConnector } from '@dejavas/connector-apollo';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetchMock(
  opts: { status?: number; body?: unknown; shouldThrow?: Error } = {},
) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (opts.shouldThrow) throw opts.shouldThrow;
    const status = opts.status ?? 200;
    const isNullBodyStatus =
      status === 101 || status === 103 || status === 204 || status === 205 || status === 304;
    const body = isNullBodyStatus ? null : JSON.stringify(opts.body ?? {});
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('ApolloConnector.supports', () => {
  const c = new ApolloConnector({ apiKey: 'x' });
  it('recognizes the three registered tools', () => {
    assert.equal(c.supports('apollo.people.match'), true);
    assert.equal(c.supports('apollo.people.search'), true);
    assert.equal(c.supports('apollo.organizations.match'), true);
  });
  it('rejects unknown', () => {
    assert.equal(c.supports('apollo.organizations.search'), false);
    assert.equal(c.supports('hubspot.contacts.update'), false);
  });
});

describe('ApolloConnector.invoke — input validation', () => {
  it('returns connector_not_configured without apiKey', async () => {
    const c = new ApolloConnector();
    const r = await c.invoke('apollo.people.match', {
      email: 'a@b.com',
    });
    assert.equal(r.error?.code, 'connector_not_configured');
  });

  it('returns invalid_params when no identifier given to people.match', async () => {
    const { fetchImpl } = makeFetchMock();
    const c = new ApolloConnector({ apiKey: 'x', fetchImpl });
    const r = await c.invoke('apollo.people.match', {});
    assert.equal(r.error?.code, 'invalid_params');
  });

  it('returns invalid_params when only first_name without last_name', async () => {
    const { fetchImpl } = makeFetchMock();
    const c = new ApolloConnector({ apiKey: 'x', fetchImpl });
    const r = await c.invoke('apollo.people.match', { first_name: 'Alice' });
    assert.equal(r.error?.code, 'invalid_params');
  });

  it('returns invalid_params for missing domain on organizations.match', async () => {
    const { fetchImpl } = makeFetchMock();
    const c = new ApolloConnector({ apiKey: 'x', fetchImpl });
    const r = await c.invoke('apollo.organizations.match', {});
    assert.equal(r.error?.code, 'invalid_params');
  });

  it('returns invalid_params for non-email email field', async () => {
    const { fetchImpl } = makeFetchMock();
    const c = new ApolloConnector({ apiKey: 'x', fetchImpl });
    const r = await c.invoke('apollo.people.match', { email: 'not-email' });
    assert.equal(r.error?.code, 'invalid_params');
  });

  it('returns unsupported_tool for unknown', async () => {
    const c = new ApolloConnector({ apiKey: 'x' });
    const r = await c.invoke('apollo.organizations.search', {});
    assert.equal(r.error?.code, 'unsupported_tool');
  });
});

describe('ApolloConnector.invoke — HTTP behavior', () => {
  it('people.match POSTs to /v1/people/match with X-Api-Key header', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      status: 200,
      body: { person: { id: 'p1', email: 'lead@acme.com' } },
    });
    const c = new ApolloConnector({ apiKey: 'apl-key-test', fetchImpl });
    const r = await c.invoke('apollo.people.match', {
      email: 'lead@acme.com',
      reveal_personal_emails: true,
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(calls[0]!.url, 'https://api.apollo.io/v1/people/match');
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.deepEqual(body, {
      email: 'lead@acme.com',
      reveal_personal_emails: true,
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['X-Api-Key'], 'apl-key-test');
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers.accept, 'application/json');
  });

  it('people.match accepts first_name+last_name without email', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new ApolloConnector({ apiKey: 'x', fetchImpl });
    const r = await c.invoke('apollo.people.match', {
      first_name: 'Alice',
      last_name: 'Anderson',
      organization_name: 'Acme',
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
  });

  it('organizations.match POSTs to /v1/organizations/match with domain', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      status: 200,
      body: { organization: { id: 'o1', domain: 'acme.com' } },
    });
    const c = new ApolloConnector({ apiKey: 'x', fetchImpl });
    await c.invoke('apollo.organizations.match', { domain: 'acme.com' });
    assert.equal(
      calls[0]!.url,
      'https://api.apollo.io/v1/organizations/match',
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.deepEqual(body, { domain: 'acme.com' });
  });

  it('people.search forwards array params and pagination', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      status: 200,
      body: { people: [], pagination: { page: 1, total_pages: 0 } },
    });
    const c = new ApolloConnector({ apiKey: 'x', fetchImpl });
    await c.invoke('apollo.people.search', {
      person_titles: ['VP Sales', 'Head of RevOps'],
      organization_domains: ['acme.com', 'globex.com'],
      page: 1,
      per_page: 25,
    });
    assert.equal(calls[0]!.url, 'https://api.apollo.io/v1/people/search');
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.deepEqual(body.person_titles, ['VP Sales', 'Head of RevOps']);
    assert.deepEqual(body.organization_domains, ['acme.com', 'globex.com']);
    assert.equal(body.per_page, 25);
  });

  it('rejects per_page over 100', async () => {
    const { fetchImpl } = makeFetchMock();
    const c = new ApolloConnector({ apiKey: 'x', fetchImpl });
    const r = await c.invoke('apollo.people.search', { per_page: 200 });
    assert.equal(r.error?.code, 'invalid_params');
  });

  it('maps Apollo {error: "..."} to http_<status> with that message', async () => {
    const { fetchImpl } = makeFetchMock({
      status: 401,
      body: { error: 'Authentication failed: invalid api key' },
    });
    const c = new ApolloConnector({ apiKey: 'bad', fetchImpl });
    const r = await c.invoke('apollo.people.match', { email: 'a@b.com' });
    assert.equal(r.error?.code, 'http_401');
    assert.match(r.error?.message ?? '', /Authentication failed/);
  });

  it('falls back to errors[0] when error field absent', async () => {
    const { fetchImpl } = makeFetchMock({
      status: 422,
      body: { errors: ['Daily request limit exceeded'] },
    });
    const c = new ApolloConnector({ apiKey: 'x', fetchImpl });
    const r = await c.invoke('apollo.people.match', { email: 'a@b.com' });
    assert.equal(r.error?.code, 'http_422');
    assert.match(r.error?.message ?? '', /Daily request limit/);
  });

  it('strips trailing slash from custom baseUrl', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new ApolloConnector({
      apiKey: 'x',
      baseUrl: 'https://api.apollo.io/',
      fetchImpl,
    });
    await c.invoke('apollo.organizations.match', { domain: 'a.com' });
    assert.equal(
      calls[0]!.url,
      'https://api.apollo.io/v1/organizations/match',
    );
  });

  it('maps fetch throws to network_error', async () => {
    const { fetchImpl } = makeFetchMock({
      shouldThrow: new Error('ETIMEDOUT'),
    });
    const c = new ApolloConnector({ apiKey: 'x', fetchImpl });
    const r = await c.invoke('apollo.people.match', { email: 'a@b.com' });
    assert.equal(r.error?.code, 'network_error');
  });
});
