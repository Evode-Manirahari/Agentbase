// Pure unit tests for SalesforceConnector — no DB, no network.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { SalesforceConnector } from '@dejavas/connector-salesforce';

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
    const body = isNullBodyStatus
      ? null
      : JSON.stringify(opts.body ?? {});
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const INSTANCE = 'https://test.my.salesforce.com';

describe('SalesforceConnector.supports', () => {
  const c = new SalesforceConnector({
    accessToken: 'x',
    instanceUrl: INSTANCE,
  });

  it('recognizes account/opportunity/contact CRUD tools', () => {
    assert.equal(c.supports('salesforce.account.create'), true);
    assert.equal(c.supports('salesforce.account.update'), true);
    assert.equal(c.supports('salesforce.account.get'), true);
    assert.equal(c.supports('salesforce.opportunity.create'), true);
    assert.equal(c.supports('salesforce.opportunity.update'), true);
    assert.equal(c.supports('salesforce.opportunity.get'), true);
    assert.equal(c.supports('salesforce.contact.create'), true);
    assert.equal(c.supports('salesforce.contact.update'), true);
    assert.equal(c.supports('salesforce.contact.get'), true);
  });

  it('rejects unknown tools', () => {
    assert.equal(c.supports('hubspot.contacts.update'), false);
    assert.equal(c.supports('salesforce.lead.create'), false);
    assert.equal(c.supports(''), false);
  });
});

describe('SalesforceConnector.invoke — input validation', () => {
  it('returns unsupported_tool for unknown tool', async () => {
    const c = new SalesforceConnector({
      accessToken: 'x',
      instanceUrl: INSTANCE,
    });
    const r = await c.invoke('mystery.tool', {});
    assert.equal(r.error?.code, 'unsupported_tool');
  });

  it('returns connector_not_configured when token is missing', async () => {
    const c = new SalesforceConnector({ instanceUrl: INSTANCE });
    const r = await c.invoke('salesforce.account.create', { fields: { Name: 'X' } });
    assert.equal(r.error?.code, 'connector_not_configured');
  });

  it('returns connector_not_configured when instanceUrl is missing', async () => {
    const c = new SalesforceConnector({ accessToken: 'x' });
    const r = await c.invoke('salesforce.account.create', { fields: { Name: 'X' } });
    assert.equal(r.error?.code, 'connector_not_configured');
  });

  it('returns invalid_params for missing accountId on update', async () => {
    const { fetchImpl } = makeFetchMock();
    const c = new SalesforceConnector({
      accessToken: 'x',
      instanceUrl: INSTANCE,
      fetchImpl,
    });
    const r = await c.invoke('salesforce.account.update', { fields: {} });
    assert.equal(r.error?.code, 'invalid_params');
    assert.ok(Array.isArray(r.error?.details));
  });
});

describe('SalesforceConnector.invoke — HTTP behavior', () => {
  it('account.update issues PATCH to /services/data/v60.0/sobjects/Account/{id} with fields body', async () => {
    const { fetchImpl, calls } = makeFetchMock({ status: 204 });
    const c = new SalesforceConnector({
      accessToken: 'pat-test',
      instanceUrl: INSTANCE,
      fetchImpl,
    });
    const r = await c.invoke('salesforce.account.update', {
      accountId: '001abc',
      fields: { Name: 'Acme', Industry: 'Tech' },
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0]!.init.method, 'PATCH');
    assert.equal(
      calls[0]!.url,
      `${INSTANCE}/services/data/v60.0/sobjects/Account/001abc`,
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.deepEqual(body, { Name: 'Acme', Industry: 'Tech' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer pat-test');
  });

  it('opportunity.create issues POST and returns the response body on 201', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      status: 201,
      body: { id: '006xyz', success: true },
    });
    const c = new SalesforceConnector({
      accessToken: 'x',
      instanceUrl: INSTANCE,
      fetchImpl,
    });
    const r = await c.invoke('salesforce.opportunity.create', {
      fields: { Name: 'Big deal', StageName: 'Prospecting', CloseDate: '2026-12-31' },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { id: '006xyz', success: true });
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(
      calls[0]!.url,
      `${INSTANCE}/services/data/v60.0/sobjects/Opportunity`,
    );
  });

  it('contact.get appends ?fields=… query when provided', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new SalesforceConnector({
      accessToken: 'x',
      instanceUrl: INSTANCE,
      fetchImpl,
    });
    await c.invoke('salesforce.contact.get', {
      contactId: '003abc',
      fields: ['Email', 'FirstName', 'LastName'],
    });
    assert.equal(calls[0]!.init.method, 'GET');
    assert.match(
      calls[0]!.url,
      /\/sobjects\/Contact\/003abc\?fields=Email%2CFirstName%2CLastName$/,
    );
  });

  it('contact.get without fields has no query string', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new SalesforceConnector({
      accessToken: 'x',
      instanceUrl: INSTANCE,
      fetchImpl,
    });
    await c.invoke('salesforce.contact.get', { contactId: '003abc' });
    assert.equal(
      calls[0]!.url,
      `${INSTANCE}/services/data/v60.0/sobjects/Contact/003abc`,
    );
  });

  it('maps Salesforce error array to http_<status> with first message', async () => {
    const { fetchImpl } = makeFetchMock({
      status: 400,
      body: [
        { errorCode: 'INVALID_FIELD', message: "No such column 'Bogus' on entity 'Account'" },
      ],
    });
    const c = new SalesforceConnector({
      accessToken: 'x',
      instanceUrl: INSTANCE,
      fetchImpl,
    });
    const r = await c.invoke('salesforce.account.update', {
      accountId: '001x',
      fields: { Bogus: 'value' },
    });
    assert.equal(r.error?.code, 'http_400');
    assert.match(r.error?.message ?? '', /No such column 'Bogus'/);
    assert.ok(Array.isArray(r.error?.details));
  });

  it('maps HTTP 401 to http_401', async () => {
    const { fetchImpl } = makeFetchMock({
      status: 401,
      body: [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }],
    });
    const c = new SalesforceConnector({
      accessToken: 'expired',
      instanceUrl: INSTANCE,
      fetchImpl,
    });
    const r = await c.invoke('salesforce.account.get', { accountId: '001x' });
    assert.equal(r.error?.code, 'http_401');
  });

  it('maps fetch throws to network_error', async () => {
    const { fetchImpl } = makeFetchMock({
      shouldThrow: new Error('ECONNREFUSED'),
    });
    const c = new SalesforceConnector({
      accessToken: 'x',
      instanceUrl: INSTANCE,
      fetchImpl,
    });
    const r = await c.invoke('salesforce.contact.get', { contactId: '003' });
    assert.equal(r.error?.code, 'network_error');
    assert.match(r.error?.message ?? '', /ECONNREFUSED/);
  });

  it('strips a trailing slash from instanceUrl', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new SalesforceConnector({
      accessToken: 'x',
      instanceUrl: `${INSTANCE}/`,
      fetchImpl,
    });
    await c.invoke('salesforce.account.create', { fields: { Name: 'X' } });
    // Should NOT have a double slash
    assert.equal(
      calls[0]!.url,
      `${INSTANCE}/services/data/v60.0/sobjects/Account`,
    );
  });
});
