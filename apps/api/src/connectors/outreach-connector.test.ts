// Pure unit tests for OutreachConnector — no DB, no network.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { OutreachConnector } from '@dejavas/connector-outreach';

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
      headers: { 'content-type': 'application/vnd.api+json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('OutreachConnector.supports', () => {
  const c = new OutreachConnector({ accessToken: 'x' });
  it('recognizes the five registered tools', () => {
    assert.equal(c.supports('outreach.prospects.create'), true);
    assert.equal(c.supports('outreach.prospects.update'), true);
    assert.equal(c.supports('outreach.prospects.get'), true);
    assert.equal(c.supports('outreach.sequences.enroll'), true);
    assert.equal(c.supports('outreach.tasks.create'), true);
  });
  it('rejects unknown', () => {
    assert.equal(c.supports('outreach.accounts.create'), false);
    assert.equal(c.supports('hubspot.contacts.update'), false);
    assert.equal(c.supports(''), false);
  });
});

describe('OutreachConnector.invoke — input validation', () => {
  it('returns connector_not_configured without token', async () => {
    const c = new OutreachConnector();
    const r = await c.invoke('outreach.prospects.create', { attributes: {} });
    assert.equal(r.error?.code, 'connector_not_configured');
  });

  it('returns invalid_params for missing prospectId on update', async () => {
    const { fetchImpl } = makeFetchMock();
    const c = new OutreachConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('outreach.prospects.update', { attributes: {} });
    assert.equal(r.error?.code, 'invalid_params');
  });

  it('returns invalid_params for missing relationships on enroll', async () => {
    const { fetchImpl } = makeFetchMock();
    const c = new OutreachConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('outreach.sequences.enroll', {
      prospectId: '1',
    });
    assert.equal(r.error?.code, 'invalid_params');
  });

  it('returns unsupported_tool for unknown', async () => {
    const c = new OutreachConnector({ accessToken: 'x' });
    const r = await c.invoke('outreach.accounts.create', { attributes: {} });
    assert.equal(r.error?.code, 'unsupported_tool');
  });
});

describe('OutreachConnector.invoke — HTTP behavior', () => {
  it('prospects.create POSTs JSON:API envelope to /api/v2/prospects', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      status: 201,
      body: { data: { id: '42', type: 'prospect' } },
    });
    const c = new OutreachConnector({ accessToken: 'tok', fetchImpl });
    const r = await c.invoke('outreach.prospects.create', {
      attributes: {
        emails: ['lead@acme.com'],
        firstName: 'Alice',
        lastName: 'Anderson',
      },
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(calls[0]!.url, 'https://api.outreach.io/api/v2/prospects');
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.deepEqual(body, {
      data: {
        type: 'prospect',
        attributes: {
          emails: ['lead@acme.com'],
          firstName: 'Alice',
          lastName: 'Anderson',
        },
      },
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer tok');
    assert.equal(headers['content-type'], 'application/vnd.api+json');
    assert.equal(headers.accept, 'application/vnd.api+json');
  });

  it('prospects.update PATCHes /prospects/:id with id in the body envelope', async () => {
    const { fetchImpl, calls } = makeFetchMock({ status: 200 });
    const c = new OutreachConnector({ accessToken: 'x', fetchImpl });
    await c.invoke('outreach.prospects.update', {
      prospectId: 999,
      attributes: { stage: 'replied' },
    });
    assert.equal(calls[0]!.init.method, 'PATCH');
    assert.equal(calls[0]!.url, 'https://api.outreach.io/api/v2/prospects/999');
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.data.id, '999');
    assert.equal(body.data.type, 'prospect');
    assert.deepEqual(body.data.attributes, { stage: 'replied' });
  });

  it('prospects.get issues GET to /prospects/:id', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new OutreachConnector({ accessToken: 'x', fetchImpl });
    await c.invoke('outreach.prospects.get', { prospectId: 'abc' });
    assert.equal(calls[0]!.init.method, 'GET');
    assert.equal(calls[0]!.url, 'https://api.outreach.io/api/v2/prospects/abc');
    assert.equal(calls[0]!.init.body, null);
  });

  it('sequences.enroll POSTs sequenceState with relationships envelope', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      status: 201,
      body: { data: { id: '1', type: 'sequenceState' } },
    });
    const c = new OutreachConnector({ accessToken: 'x', fetchImpl });
    await c.invoke('outreach.sequences.enroll', {
      prospectId: 'p1',
      sequenceId: 's1',
      mailboxId: 'm1',
    });
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(
      calls[0]!.url,
      'https://api.outreach.io/api/v2/sequenceStates',
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.data.type, 'sequenceState');
    assert.deepEqual(body.data.relationships.prospect.data, {
      type: 'prospect',
      id: 'p1',
    });
    assert.deepEqual(body.data.relationships.sequence.data, {
      type: 'sequence',
      id: 's1',
    });
    assert.deepEqual(body.data.relationships.mailbox.data, {
      type: 'mailbox',
      id: 'm1',
    });
  });

  it('tasks.create with prospectId attaches a relationship', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new OutreachConnector({ accessToken: 'x', fetchImpl });
    await c.invoke('outreach.tasks.create', {
      attributes: { subject: 'Follow up', taskType: 'call' },
      prospectId: 'p1',
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.data.type, 'task');
    assert.deepEqual(body.data.attributes, {
      subject: 'Follow up',
      taskType: 'call',
    });
    assert.deepEqual(body.data.relationships.prospect.data, {
      type: 'prospect',
      id: 'p1',
    });
  });

  it('tasks.create without prospectId omits relationships', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new OutreachConnector({ accessToken: 'x', fetchImpl });
    await c.invoke('outreach.tasks.create', {
      attributes: { subject: 'Standalone', taskType: 'general' },
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.data.type, 'task');
    assert.equal(body.data.relationships, undefined);
  });

  it('maps JSON:API errors to http_<status> with first detail', async () => {
    const { fetchImpl } = makeFetchMock({
      status: 422,
      body: {
        errors: [
          {
            id: 'e1',
            status: '422',
            title: 'Unprocessable Entity',
            detail: "emails: can't be blank",
          },
        ],
      },
    });
    const c = new OutreachConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('outreach.prospects.create', { attributes: {} });
    assert.equal(r.error?.code, 'http_422');
    assert.match(r.error?.message ?? '', /emails: can't be blank/);
    const details = r.error?.details as { errors: { detail: string }[] };
    assert.equal(details.errors[0]?.detail, "emails: can't be blank");
  });

  it('falls back to title when detail is absent', async () => {
    const { fetchImpl } = makeFetchMock({
      status: 401,
      body: { errors: [{ title: 'Unauthorized' }] },
    });
    const c = new OutreachConnector({ accessToken: 'expired', fetchImpl });
    const r = await c.invoke('outreach.prospects.get', { prospectId: '1' });
    assert.equal(r.error?.code, 'http_401');
    assert.match(r.error?.message ?? '', /Unauthorized/);
  });

  it('strips trailing slash from custom baseUrl', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new OutreachConnector({
      accessToken: 'x',
      baseUrl: 'https://api.outreach.io/',
      fetchImpl,
    });
    await c.invoke('outreach.prospects.create', { attributes: {} });
    assert.equal(calls[0]!.url, 'https://api.outreach.io/api/v2/prospects');
  });

  it('maps fetch throws to network_error', async () => {
    const { fetchImpl } = makeFetchMock({
      shouldThrow: new Error('ETIMEDOUT'),
    });
    const c = new OutreachConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('outreach.prospects.get', { prospectId: '1' });
    assert.equal(r.error?.code, 'network_error');
  });
});
