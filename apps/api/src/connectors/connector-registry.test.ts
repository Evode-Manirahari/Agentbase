// Pure unit tests for ConnectorRegistry — no DB, no network. Confirms the
// five connectors boot correctly and that tool-prefix routing dispatches
// to the right one.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ConfigService } from '@nestjs/config';
import { ConnectorRegistry } from './connector-registry.js';

class FakeConfig {
  constructor(private readonly env: Record<string, string | undefined> = {}) {}
  get<T = string>(key: string): T | undefined {
    return this.env[key] as T | undefined;
  }
}

describe('ConnectorRegistry — boot', () => {
  it('boots all five connectors even with no env vars set', () => {
    const r = new ConnectorRegistry(new FakeConfig() as unknown as ConfigService);
    const names = r.list().map((c) => c.name).sort();
    assert.deepEqual(names, ['apollo', 'gmail', 'hubspot', 'outreach', 'salesforce']);
  });

  it('boots all five regardless of which credentials are populated', () => {
    const r = new ConnectorRegistry(
      new FakeConfig({
        HUBSPOT_ACCESS_TOKEN: 'pat-hs',
        APOLLO_API_KEY: 'apl-key',
      }) as unknown as ConfigService,
    );
    assert.equal(r.list().length, 5);
  });
});

describe('ConnectorRegistry — tool-prefix routing', () => {
  const r = new ConnectorRegistry(new FakeConfig() as unknown as ConfigService);

  const matchups: { tool: string; expected: string | null }[] = [
    { tool: 'hubspot.contacts.update', expected: 'hubspot' },
    { tool: 'hubspot.deals.create', expected: 'hubspot' },
    { tool: 'salesforce.account.create', expected: 'salesforce' },
    { tool: 'salesforce.opportunity.update', expected: 'salesforce' },
    { tool: 'gmail.send', expected: 'gmail' },
    { tool: 'gmail.draft.create', expected: 'gmail' },
    { tool: 'outreach.prospects.create', expected: 'outreach' },
    { tool: 'outreach.sequences.enroll', expected: 'outreach' },
    { tool: 'apollo.people.match', expected: 'apollo' },
    { tool: 'apollo.organizations.match', expected: 'apollo' },
  ];

  for (const { tool, expected } of matchups) {
    it(`routes ${tool} → ${expected}`, () => {
      const c = r.resolve(tool);
      assert.equal(c?.name, expected);
    });
  }

  it('returns null for tools no connector supports', () => {
    assert.equal(r.resolve('linkedin.companies.search'), null);
    assert.equal(r.resolve('zendesk.tickets.create'), null);
    assert.equal(r.resolve(''), null);
  });
});

describe('ConnectorRegistry — config-not-set behavior on invoke', () => {
  it('without any env, every connector responds with connector_not_configured', async () => {
    const r = new ConnectorRegistry(new FakeConfig() as unknown as ConfigService);
    const calls = [
      { tool: 'hubspot.contacts.update', params: { contactId: '1', properties: {} } },
      {
        tool: 'salesforce.account.update',
        params: { accountId: '1', fields: {} },
      },
      { tool: 'gmail.send', params: { to: 'a@b.com', subject: 's', body: 'x' } },
      {
        tool: 'outreach.prospects.create',
        params: { attributes: { emails: ['a@b.com'] } },
      },
      { tool: 'apollo.people.match', params: { email: 'a@b.com' } },
    ];
    for (const call of calls) {
      const c = r.resolve(call.tool);
      assert.ok(c, `no connector resolved ${call.tool}`);
      const result = await c!.invoke(call.tool, call.params);
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, 'connector_not_configured');
    }
  });
});
