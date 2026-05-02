// Pure unit tests for HubspotConnector — no DB, no network. Uses a fetch mock.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { HubspotConnector } from '@dejavas/connector-hubspot';

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
    const body = opts.body ?? {};
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('HubspotConnector.supports', () => {
  const c = new HubspotConnector({ accessToken: 'x' });

  it('recognizes registered tools', () => {
    assert.equal(c.supports('hubspot.contacts.update'), true);
    assert.equal(c.supports('hubspot.contacts.create'), true);
    assert.equal(c.supports('hubspot.contacts.get'), true);
    assert.equal(c.supports('hubspot.deals.update'), true);
    assert.equal(c.supports('hubspot.deals.create'), true);
    assert.equal(c.supports('hubspot.deals.get'), true);
  });

  it('rejects unknown tools', () => {
    assert.equal(c.supports('salesforce.foo'), false);
    assert.equal(c.supports('hubspot.tickets.create'), false);
    assert.equal(c.supports(''), false);
  });
});

describe('HubspotConnector.invoke — input validation', () => {
  it('returns unsupported_tool for unknown tool', async () => {
    const c = new HubspotConnector({ accessToken: 'x' });
    const r = await c.invoke('mystery.tool', {});
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'unsupported_tool');
  });

  it('returns connector_not_configured when token is missing', async () => {
    const c = new HubspotConnector({});
    const r = await c.invoke('hubspot.contacts.update', {
      contactId: '1',
      properties: {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'connector_not_configured');
  });

  it('returns invalid_params when params fail Zod (missing contactId)', async () => {
    const { fetchImpl } = makeFetchMock();
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('hubspot.contacts.update', { properties: {} });
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'invalid_params');
    assert.ok(Array.isArray(r.error?.details));
  });
});

describe('HubspotConnector.invoke — HTTP behavior', () => {
  it('contacts.update issues PATCH to right URL with bearer + body', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      status: 200,
      body: { id: '12345', properties: { lifecyclestage: 'sql' } },
    });
    const c = new HubspotConnector({ accessToken: 'pat-test', fetchImpl });
    const r = await c.invoke('hubspot.contacts.update', {
      contactId: '12345',
      properties: { lifecyclestage: 'sql' },
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init.method, 'PATCH');
    assert.equal(
      calls[0]!.url,
      'https://api.hubapi.com/crm/v3/objects/contacts/12345',
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.deepEqual(body, { properties: { lifecyclestage: 'sql' } });
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer pat-test');
    assert.equal(headers['content-type'], 'application/json');
  });

  it('contacts.create issues POST to /crm/v3/objects/contacts', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    await c.invoke('hubspot.contacts.create', {
      properties: { email: 'a@b.com' },
    });
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(calls[0]!.url, 'https://api.hubapi.com/crm/v3/objects/contacts');
  });

  it('deals.get appends ?properties=... query when provided', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    await c.invoke('hubspot.deals.get', {
      dealId: 'd1',
      properties: ['amount', 'stage'],
    });
    assert.equal(calls[0]!.init.method, 'GET');
    assert.match(calls[0]!.url, /deals\/d1\?properties=amount%2Cstage$/);
  });

  it('deals.get without properties has no query string', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    await c.invoke('hubspot.deals.get', { dealId: 'd1' });
    assert.equal(
      calls[0]!.url,
      'https://api.hubapi.com/crm/v3/objects/deals/d1',
    );
  });

  it('maps HTTP 4xx → http_<status> with body details', async () => {
    const { fetchImpl } = makeFetchMock({
      status: 401,
      body: {
        message: 'authentication failed',
        category: 'INVALID_AUTHENTICATION',
      },
    });
    const c = new HubspotConnector({ accessToken: 'bad', fetchImpl });
    const r = await c.invoke('hubspot.contacts.update', {
      contactId: '1',
      properties: {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'http_401');
    assert.equal(r.error?.message, 'authentication failed');
    assert.deepEqual(
      r.error?.details,
      { message: 'authentication failed', category: 'INVALID_AUTHENTICATION' },
    );
  });

  it('maps HTTP 5xx → http_<status>', async () => {
    const { fetchImpl } = makeFetchMock({
      status: 503,
      body: { message: 'service unavailable' },
    });
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('hubspot.deals.update', {
      dealId: '1',
      properties: {},
    });
    assert.equal(r.error?.code, 'http_503');
    assert.equal(r.error?.message, 'service unavailable');
  });

  it('maps fetch throws to network_error', async () => {
    const { fetchImpl } = makeFetchMock({
      shouldThrow: new Error('ENOTFOUND api.hubapi.com'),
    });
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('hubspot.contacts.update', {
      contactId: '1',
      properties: {},
    });
    assert.equal(r.error?.code, 'network_error');
    assert.match(r.error?.message ?? '', /ENOTFOUND/);
  });

  it('respects custom baseUrl', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new HubspotConnector({
      accessToken: 'x',
      baseUrl: 'https://eu1.hubapi.com/',
      fetchImpl,
    });
    await c.invoke('hubspot.contacts.create', { properties: {} });
    assert.match(calls[0]!.url, /^https:\/\/eu1\.hubapi\.com\//);
  });
});
