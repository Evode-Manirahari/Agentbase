// Pure unit tests for HubspotConnector — no DB, no network. Uses a fetch mock.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { HubspotConnector } from '@agentbase/connector-hubspot';

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

function makeSequenceFetchMock(
  responses: { status?: number; body?: unknown }[],
) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? {};
    const status = next.status ?? 200;
    const body = next.body ?? {};
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
    assert.equal(c.supports('hubspot.connection.test'), true);
    assert.equal(c.supports('hubspot.contacts.search'), true);
    assert.equal(c.supports('hubspot.contacts.upsert'), true);
    assert.equal(c.supports('hubspot.contacts.update'), true);
    assert.equal(c.supports('hubspot.contacts.create'), true);
    assert.equal(c.supports('hubspot.contacts.get'), true);
    assert.equal(c.supports('hubspot.contacts.associate'), true);
    assert.equal(c.supports('hubspot.deals.update'), true);
    assert.equal(c.supports('hubspot.deals.create'), true);
    assert.equal(c.supports('hubspot.deals.get'), true);
    assert.equal(c.supports('hubspot.deals.associate'), true);
    assert.equal(c.supports('hubspot.notes.create'), true);
    assert.equal(c.supports('hubspot.tasks.create'), true);
    assert.equal(c.supports('hubspot.leads.create_deal'), true);
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
  it('connection.test validates the token with a tiny contacts read', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      status: 200,
      body: { results: [] },
    });
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('hubspot.connection.test', {});
    assert.equal(r.ok, true);
    assert.equal(calls[0]!.init.method, 'GET');
    assert.equal(
      calls[0]!.url,
      'https://api.hubapi.com/crm/v3/objects/contacts?limit=1&properties=email',
    );
  });

  it('contacts.search issues POST to search endpoint with query body', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      body: { total: 1, results: [{ id: 'c1' }] },
    });
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('hubspot.contacts.search', {
      query: 'ada@example.com',
      properties: ['email', 'firstname'],
      limit: 20,
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(
      calls[0]!.url,
      'https://api.hubapi.com/crm/v3/objects/contacts/search',
    );
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
      query: 'ada@example.com',
      properties: ['email', 'firstname'],
      limit: 20,
    });
  });

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

  it('contacts.upsert searches by email then updates an existing contact', async () => {
    const { fetchImpl, calls } = makeSequenceFetchMock([
      { body: { results: [{ id: '12345' }] } },
      { body: { id: '12345', properties: { email: 'ada@example.com' } } },
    ]);
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('hubspot.contacts.upsert', {
      email: 'ada@example.com',
      properties: { firstname: 'Ada' },
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(
      calls[0]!.url,
      'https://api.hubapi.com/crm/v3/objects/contacts/search',
    );
    assert.equal(calls[1]!.init.method, 'PATCH');
    assert.equal(
      calls[1]!.url,
      'https://api.hubapi.com/crm/v3/objects/contacts/12345',
    );
    assert.deepEqual(JSON.parse(calls[1]!.init.body as string), {
      properties: { firstname: 'Ada', email: 'ada@example.com' },
    });
    assert.equal(
      (r.data as { operation?: string }).operation,
      'updated',
    );
  });

  it('contacts.upsert creates a contact when search has no result', async () => {
    const { fetchImpl, calls } = makeSequenceFetchMock([
      { body: { results: [] } },
      { body: { id: 'new-1', properties: { email: 'new@example.com' } } },
    ]);
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('hubspot.contacts.upsert', {
      email: 'new@example.com',
      properties: { company: 'NewCo' },
    });
    assert.equal(r.ok, true);
    assert.equal(calls[1]!.init.method, 'POST');
    assert.equal(
      calls[1]!.url,
      'https://api.hubapi.com/crm/v3/objects/contacts',
    );
    assert.deepEqual(JSON.parse(calls[1]!.init.body as string), {
      properties: { company: 'NewCo', email: 'new@example.com' },
    });
    assert.equal((r.data as { operation?: string }).operation, 'created');
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

  it('notes.create sends timeline note properties and associations', async () => {
    const { fetchImpl, calls } = makeFetchMock({ body: { id: 'n1' } });
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('hubspot.notes.create', {
      body: 'Spoke with Ada.',
      timestamp: '2026-05-14T12:00:00.000Z',
      associations: [
        {
          toObjectType: 'contact',
          toObjectId: 'c1',
          associationTypeId: 202,
        },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(calls[0]!.url, 'https://api.hubapi.com/crm/v3/objects/notes');
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
      properties: {
        hs_timestamp: '2026-05-14T12:00:00.000Z',
        hs_note_body: 'Spoke with Ada.',
      },
      associations: [
        {
          to: { id: 'c1' },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: 202,
            },
          ],
        },
      ],
    });
  });

  it('tasks.create sends task fields and association payload', async () => {
    const { fetchImpl, calls } = makeFetchMock({ body: { id: 't1' } });
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('hubspot.tasks.create', {
      subject: 'Follow up',
      body: 'Send pricing.',
      timestamp: '2026-05-15T12:00:00.000Z',
      priority: 'HIGH',
      type: 'EMAIL',
      associations: [
        {
          toObjectType: 'deal',
          toObjectId: 'd1',
          associationTypeId: 216,
        },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0]!.url, 'https://api.hubapi.com/crm/v3/objects/tasks');
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
      properties: {
        hs_timestamp: '2026-05-15T12:00:00.000Z',
        hs_task_subject: 'Follow up',
        hs_task_body: 'Send pricing.',
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: 'HIGH',
        hs_task_type: 'EMAIL',
      },
      associations: [
        {
          to: { id: 'd1' },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: 216,
            },
          ],
        },
      ],
    });
  });

  it('leads.create_deal upserts contact, creates associated deal, and logs a note', async () => {
    const { fetchImpl, calls } = makeSequenceFetchMock([
      { body: { results: [] } },
      { body: { id: 'c1', properties: { email: 'ada@example.com' } } },
      { body: { id: 'd1', properties: { dealname: 'Ada - Pilot' } } },
      { body: { associated: true } },
      { body: { id: 'n1' } },
    ]);
    const c = new HubspotConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('hubspot.leads.create_deal', {
      contact: {
        email: 'ada@example.com',
        firstname: 'Ada',
        lastname: 'Lovelace',
        company: 'Analytical Engines',
      },
      deal: {
        dealname: 'Ada - Pilot',
        amount: 15000,
        dealstage: 'appointmentscheduled',
      },
      note: {
        body: 'Inbound demo request.',
        timestamp: '2026-05-14T12:00:00.000Z',
      },
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 5);
    assert.equal(calls[0]!.url, 'https://api.hubapi.com/crm/v3/objects/contacts/search');
    assert.equal(calls[1]!.url, 'https://api.hubapi.com/crm/v3/objects/contacts');
    assert.equal(calls[2]!.url, 'https://api.hubapi.com/crm/v3/objects/deals');
    assert.equal(
      calls[3]!.url,
      'https://api.hubapi.com/crm/v3/objects/contacts/c1/associations/deals/d1/4',
    );
    assert.equal(calls[4]!.url, 'https://api.hubapi.com/crm/v3/objects/notes');
    assert.deepEqual(JSON.parse(calls[2]!.init.body as string), {
      properties: {
        dealname: 'Ada - Pilot',
        amount: 15000,
        dealstage: 'appointmentscheduled',
      },
    });
    const noteBody = JSON.parse(calls[4]!.init.body as string);
    assert.deepEqual(noteBody.associations, [
      {
        to: { id: 'c1' },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: 202,
          },
        ],
      },
      {
        to: { id: 'd1' },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: 214,
          },
        ],
      },
    ]);
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
