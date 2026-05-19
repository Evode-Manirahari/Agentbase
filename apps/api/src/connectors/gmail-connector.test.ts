// Pure unit tests for GmailConnector — no DB, no network.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  GmailConnector,
  base64UrlEncode,
  gmailMessage,
} from '@dejavas/connector-gmail';

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

function decodeBase64Url(s: string): string {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  return new TextDecoder().decode(
    Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
  );
}

describe('GmailConnector — base64UrlEncode', () => {
  it('round-trips ASCII', () => {
    const encoded = base64UrlEncode('hello world');
    assert.equal(decodeBase64Url(encoded), 'hello world');
  });

  it('handles UTF-8 (smart quotes, accents)', () => {
    const text = 'Héllo "world" — 🎉';
    const encoded = base64UrlEncode(text);
    assert.equal(decodeBase64Url(encoded), text);
  });

  it('produces base64url alphabet (no +, /, =)', () => {
    const encoded = base64UrlEncode('???>>>'.repeat(5));
    assert.doesNotMatch(encoded, /[+/=]/);
  });
});

describe('GmailConnector — gmailMessage builder', () => {
  it('builds a To/Subject/body RFC 2822 message and base64url-encodes it', () => {
    const out = gmailMessage({
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'Hi alice',
    });
    const raw = decodeBase64Url(out.raw);
    assert.match(raw, /^To: alice@example\.com\r\n/);
    assert.match(raw, /Subject: Hello\r\n/);
    assert.match(raw, /\r\n\r\nHi alice$/);
    assert.match(raw, /Content-Type: text\/plain; charset="UTF-8"\r\n/);
  });

  it('joins multiple recipients with commas', () => {
    const out = gmailMessage({
      to: ['a@b.com', 'c@d.com'],
      subject: 'Multi',
      body: 'x',
    });
    const raw = decodeBase64Url(out.raw);
    assert.match(raw, /^To: a@b\.com, c@d\.com\r\n/);
  });

  it('emits Cc and Bcc only when supplied', () => {
    const minimal = decodeBase64Url(
      gmailMessage({ to: 'a@b.com', subject: 's', body: 'x' }).raw,
    );
    assert.doesNotMatch(minimal, /^Cc:/m);
    assert.doesNotMatch(minimal, /^Bcc:/m);

    const full = decodeBase64Url(
      gmailMessage({
        to: 'a@b.com',
        cc: 'c@b.com',
        bcc: 'd@b.com',
        subject: 's',
        body: 'x',
      }).raw,
    );
    assert.match(full, /^Cc: c@b\.com\r\n/m);
    assert.match(full, /^Bcc: d@b\.com\r\n/m);
  });

  it('switches Content-Type to text/html when html: true', () => {
    const raw = decodeBase64Url(
      gmailMessage({
        to: 'a@b.com',
        subject: 's',
        body: '<p>x</p>',
        html: true,
      }).raw,
    );
    assert.match(raw, /Content-Type: text\/html; charset="UTF-8"\r\n/);
  });

  it('forwards threadId when supplied', () => {
    const out = gmailMessage({
      to: 'a@b.com',
      subject: 's',
      body: 'x',
      threadId: 'thr_abc',
    });
    assert.equal(out.threadId, 'thr_abc');
  });
});

describe('GmailConnector.supports', () => {
  const c = new GmailConnector({ accessToken: 'x' });
  it('recognizes the five registered tools', () => {
    assert.equal(c.supports('gmail.send'), true);
    assert.equal(c.supports('gmail.draft.create'), true);
    assert.equal(c.supports('gmail.draft.send'), true);
    assert.equal(c.supports('gmail.messages.get'), true);
    assert.equal(c.supports('gmail.threads.get'), true);
  });
  it('rejects unknown', () => {
    assert.equal(c.supports('gmail.threads.delete'), false);
    assert.equal(c.supports('hubspot.contacts.update'), false);
  });
});

describe('GmailConnector.invoke — input validation', () => {
  it('returns connector_not_configured without token', async () => {
    const c = new GmailConnector();
    const r = await c.invoke('gmail.send', {
      to: 'a@b.com',
      subject: 's',
      body: 'x',
    });
    assert.equal(r.error?.code, 'connector_not_configured');
  });

  it('returns invalid_params for non-email "to"', async () => {
    const { fetchImpl } = makeFetchMock();
    const c = new GmailConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('gmail.send', {
      to: 'not-an-email',
      subject: 's',
      body: 'x',
    });
    assert.equal(r.error?.code, 'invalid_params');
  });

  it('returns invalid_params for missing subject', async () => {
    const { fetchImpl } = makeFetchMock();
    const c = new GmailConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('gmail.send', {
      to: 'a@b.com',
      body: 'x',
    });
    assert.equal(r.error?.code, 'invalid_params');
  });

  it('returns unsupported_tool for unknown', async () => {
    const c = new GmailConnector({ accessToken: 'x' });
    const r = await c.invoke('gmail.threads.delete', { threadId: 't' });
    assert.equal(r.error?.code, 'unsupported_tool');
  });
});

describe('GmailConnector.invoke — HTTP behavior', () => {
  it('gmail.send issues POST to /messages/send with bearer + base64url raw', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      status: 200,
      body: { id: 'msg-1', threadId: 'thr-1' },
    });
    const c = new GmailConnector({
      accessToken: 'tok-test',
      fetchImpl,
    });
    const r = await c.invoke('gmail.send', {
      to: 'alice@dejavas.test',
      subject: 'Quarterly review',
      body: 'Hi alice — see attached.',
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(
      calls[0]!.url,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.ok(typeof body.raw === 'string');
    assert.match(decodeBase64Url(body.raw), /^To: alice@dejavas\.test\r\n/);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer tok-test');
  });

  it('respects custom userId in URL path', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new GmailConnector({
      accessToken: 'x',
      userId: 'me@workspace.example',
      fetchImpl,
    });
    await c.invoke('gmail.send', {
      to: 'a@b.com',
      subject: 's',
      body: 'x',
    });
    assert.match(
      calls[0]!.url,
      /\/users\/me%40workspace\.example\/messages\/send$/,
    );
  });

  it('gmail.draft.create wraps payload in {message: {...}}', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      status: 200,
      body: { id: 'draft-1' },
    });
    const c = new GmailConnector({ accessToken: 'x', fetchImpl });
    await c.invoke('gmail.draft.create', {
      to: 'a@b.com',
      subject: 's',
      body: 'x',
    });
    assert.equal(calls[0]!.init.method, 'POST');
    assert.match(calls[0]!.url, /\/drafts$/);
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.ok(body.message);
    assert.ok(typeof body.message.raw === 'string');
  });

  it('gmail.draft.send POSTs {id: draftId}', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      status: 200,
      body: { id: 'msg-out' },
    });
    const c = new GmailConnector({ accessToken: 'x', fetchImpl });
    await c.invoke('gmail.draft.send', { draftId: 'draft-99' });
    assert.equal(calls[0]!.init.method, 'POST');
    assert.match(calls[0]!.url, /\/drafts\/send$/);
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
      id: 'draft-99',
    });
  });

  it('gmail.messages.get appends ?format=metadata when supplied', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const c = new GmailConnector({ accessToken: 'x', fetchImpl });
    await c.invoke('gmail.messages.get', {
      messageId: 'msg-99',
      format: 'metadata',
    });
    assert.equal(calls[0]!.init.method, 'GET');
    assert.match(calls[0]!.url, /\/messages\/msg-99\?format=metadata$/);
  });

  it('maps Gmail error.json {error:{message}} to http_<status> message', async () => {
    const { fetchImpl } = makeFetchMock({
      status: 401,
      body: {
        error: {
          code: 401,
          message: 'Request had invalid authentication credentials.',
          status: 'UNAUTHENTICATED',
        },
      },
    });
    const c = new GmailConnector({ accessToken: 'expired', fetchImpl });
    const r = await c.invoke('gmail.send', {
      to: 'a@b.com',
      subject: 's',
      body: 'x',
    });
    assert.equal(r.error?.code, 'http_401');
    assert.match(r.error?.message ?? '', /invalid authentication credentials/);
  });

  it('maps fetch throws to network_error', async () => {
    const { fetchImpl } = makeFetchMock({
      shouldThrow: new Error('ETIMEDOUT'),
    });
    const c = new GmailConnector({ accessToken: 'x', fetchImpl });
    const r = await c.invoke('gmail.send', {
      to: 'a@b.com',
      subject: 's',
      body: 'x',
    });
    assert.equal(r.error?.code, 'network_error');
  });
});
