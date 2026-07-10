// Integration tests for PolicyService — require Postgres on $DATABASE_URL.

import {
  describe,
  it,
  before,
  after,
  beforeEach,
  afterEach,
} from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { BadRequestException } from '@nestjs/common';
import { schema, orgs, policies, agents } from '@agentbase/db';
import { buildAgentPermissionProfilePolicyYaml } from '@agentbase/shared';
import { PolicyService } from './policy.service.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://agentbase:agentbase@localhost:5433/agentbase';

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

before(() => {
  client = postgres(DB_URL, { max: 5 });
  db = drizzle(client, { schema });
});

after(async () => {
  await client.end();
});

describe('PolicyService.parseAndValidate', () => {
  let svc: PolicyService;
  before(() => {
    svc = new PolicyService(db);
  });

  it('accepts well-formed YAML matching the schema', () => {
    const yaml = `
version: 1
default: deny
rules:
  - match:
      tool: hubspot.contacts.update
    effect: allow
  - match:
      tool: hubspot.deals.update
      when:
        amount: { gt: 1000 }
    effect: require_approval
    approver_role: approver
    slack_channel: "#critical"
`;
    const doc = svc.parseAndValidate(yaml);
    assert.equal(doc.version, 1);
    assert.equal(doc.default, 'deny');
    assert.equal(doc.rules.length, 2);
    assert.equal(doc.rules[1]!.slack_channel, '#critical');
  });

  it('accepts profile-scoped rules generated from permission profiles', () => {
    const doc = svc.parseAndValidate(buildAgentPermissionProfilePolicyYaml());
    assert.equal(doc.default, 'deny');
    assert.ok(doc.rules.some((rule) =>
      rule.match.agent_profile === 'sales_sdr' &&
      rule.match.tool === 'gmail.send' &&
      rule.effect === 'require_approval',
    ));
    assert.ok(doc.rules.some((rule) =>
      rule.match.agent_profile === 'read_only_analyst' &&
      rule.match.tool === 'apollo.people.search' &&
      rule.effect === 'allow',
    ));
    assert.ok(doc.rules.some((rule) =>
      rule.match.agent_profile === 'openclaw_agent' &&
      rule.match.tool === 'hubspot.deals.update' &&
      rule.match.when?.['properties.amount'] &&
      rule.effect === 'require_approval',
    ));
    assert.ok(doc.rules.some((rule) =>
      rule.match.agent_profile === 'nemoclaw_sandboxed_agent' &&
      rule.match.tool === '*.delete' &&
      rule.effect === 'deny',
    ));
  });

  it('rejects malformed YAML with BadRequestException', () => {
    const bad = 'version: 1\nrules:\n  - match: {tool: foo\n  effect: allow';
    assert.throws(() => svc.parseAndValidate(bad), BadRequestException);
  });

  it('rejects YAML that fails Zod schema with structured issues', () => {
    const yaml = `
version: 1
default: deny
rules:
  - match:
      tool: ""
    effect: allow
`;
    try {
      svc.parseAndValidate(yaml);
      assert.fail('expected BadRequestException');
    } catch (err) {
      assert.ok(err instanceof BadRequestException);
      const body = err.getResponse() as { issues?: { path: unknown[] }[] };
      assert.ok(Array.isArray(body.issues));
      assert.ok(body.issues!.length > 0);
      const paths = body.issues!.map((i) => i.path.join('.'));
      assert.ok(paths.some((p) => p.includes('rules.0.match.tool')));
    }
  });

  it('rejects unknown effect with a Zod issue', () => {
    const yaml = `
version: 1
default: deny
rules:
  - match: { tool: foo }
    effect: maybe
`;
    assert.throws(() => svc.parseAndValidate(yaml), BadRequestException);
  });
});

describe('PolicyService.getActive / setActive', () => {
  let orgId: string;
  let svc: PolicyService;

  beforeEach(async () => {
    const slug = `pol-${randomUUID().slice(0, 8)}`;
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Test', slug })
      .returning();
    orgId = org!.id;
    svc = new PolicyService(db);
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('getActive returns fallback (allow-all) when no active policy', async () => {
    const active = await svc.getActive(orgId);
    assert.equal(active.policy_id, null);
    assert.equal(active.is_fallback, true);
    assert.equal(active.document?.default, 'allow');
    assert.deepEqual(active.document?.rules, []);
  });

  it('setActive creates the policy, increments version, deactivates previous', async () => {
    const v1Yaml = `version: 1\ndefault: deny\nrules: []\n`;
    const v1 = await svc.setActive({ orgId, name: 'first', yaml: v1Yaml });
    assert.equal(v1.version, 1);
    assert.equal(v1.is_fallback, false);

    const v2Yaml = `version: 1\ndefault: allow\nrules: []\n`;
    const v2 = await svc.setActive({ orgId, name: 'second', yaml: v2Yaml });
    assert.equal(v2.version, 2);

    const all = await db
      .select()
      .from(policies)
      .where(eq(policies.orgId, orgId))
      .orderBy(desc(policies.version));
    assert.equal(all.length, 2);
    assert.equal(all[0]!.version, 2);
    assert.equal(all[0]!.isActive, true);
    assert.equal(all[1]!.version, 1);
    assert.equal(all[1]!.isActive, false);

    const active = await svc.getActive(orgId);
    assert.equal(active.policy_id, v2.policy_id);
    assert.equal(active.document?.default, 'allow');
  });

  it('setActive rejects invalid YAML before any DB write', async () => {
    await assert.rejects(
      () =>
        svc.setActive({
          orgId,
          name: 'bad',
          yaml: 'version: 1\ndefault: deny\nrules:\n  - match: { tool: "" }\n    effect: allow\n',
        }),
      BadRequestException,
    );
    const rows = await db
      .select()
      .from(policies)
      .where(eq(policies.orgId, orgId));
    assert.equal(rows.length, 0);
  });

  it('versions are scoped per org (no cross-talk)', async () => {
    const slugB = `pol-${randomUUID().slice(0, 8)}`;
    const [orgB] = await db
      .insert(orgs)
      .values({ name: 'Other', slug: slugB })
      .returning();

    try {
      await svc.setActive({
        orgId,
        name: 'a',
        yaml: 'version: 1\ndefault: deny\nrules: []\n',
      });
      await svc.setActive({
        orgId,
        name: 'a',
        yaml: 'version: 1\ndefault: allow\nrules: []\n',
      });
      const orgBPolicy = await svc.setActive({
        orgId: orgB!.id,
        name: 'a',
        yaml: 'version: 1\ndefault: deny\nrules: []\n',
      });
      assert.equal(orgBPolicy.version, 1);

      const orgARows = await db
        .select()
        .from(policies)
        .where(and(eq(policies.orgId, orgId)))
        .orderBy(desc(policies.version));
      assert.equal(orgARows.length, 2);
      assert.equal(orgARows[0]!.version, 2);
    } finally {
      await db.delete(orgs).where(eq(orgs.id, orgB!.id));
    }
  });
});

describe('PolicyService.evaluate', () => {
  let orgId: string;
  let svc: PolicyService;

  beforeEach(async () => {
    const slug = `pol-${randomUUID().slice(0, 8)}`;
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Test', slug })
      .returning();
    orgId = org!.id;
    svc = new PolicyService(db);
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('uses fallback policy (allow-all) when no active policy is set', async () => {
    const decision = await svc.evaluate(orgId, {
      tool: 'random.tool',
      params: {},
    });
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.fallback, true);
  });

  it('applies the active policy when one exists', async () => {
    await svc.setActive({
      orgId,
      name: 'eval-test',
      yaml: `version: 1
default: deny
rules:
  - match: { tool: 'hubspot.contacts.update' }
    effect: allow
    reason: "contact updates ok"
`,
    });
    const decision = await svc.evaluate(orgId, {
      tool: 'hubspot.contacts.update',
      params: {},
    });
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.fallback, false);
    assert.equal(decision.reason, 'contact updates ok');

    const denied = await svc.evaluate(orgId, {
      tool: 'salesforce.opportunity.update',
      params: {},
    });
    assert.equal(denied.effect, 'deny');
  });

  it('evaluates generated profile policy against the calling agent profile', async () => {
    const [sdr] = await db
      .insert(agents)
      .values({ orgId, name: 'sdr', permissionProfile: 'sales_sdr' })
      .returning();
    const [analyst] = await db
      .insert(agents)
      .values({ orgId, name: 'analyst', permissionProfile: 'read_only_analyst' })
      .returning();
    const [openclaw] = await db
      .insert(agents)
      .values({ orgId, name: 'openclaw', permissionProfile: 'openclaw_agent' })
      .returning();
    const [nemoclaw] = await db
      .insert(agents)
      .values({
        orgId,
        name: 'nemoclaw',
        permissionProfile: 'nemoclaw_sandboxed_agent',
      })
      .returning();
    await svc.setActive({
      orgId,
      name: 'profiles',
      yaml: buildAgentPermissionProfilePolicyYaml(),
    });

    const sdrDecision = await svc.evaluate(orgId, {
      agentId: sdr!.id,
      tool: 'gmail.send',
      params: {},
    });
    assert.equal(sdrDecision.effect, 'require_approval');
    assert.equal(sdrDecision.rule_matched?.match.agent_profile, 'sales_sdr');

    const analystDecision = await svc.evaluate(orgId, {
      agentId: analyst!.id,
      tool: 'gmail.send',
      params: {},
    });
    assert.equal(analystDecision.effect, 'deny');

    const analystRead = await svc.evaluate(orgId, {
      agentId: analyst!.id,
      tool: 'apollo.people.search',
      params: {},
    });
    assert.equal(analystRead.effect, 'allow');
    assert.equal(analystRead.rule_matched?.match.agent_profile, 'read_only_analyst');

    const openclawDeal = await svc.evaluate(orgId, {
      agentId: openclaw!.id,
      tool: 'hubspot.deals.update',
      params: { properties: { amount: 15000 } },
    });
    assert.equal(openclawDeal.effect, 'require_approval');
    assert.equal(openclawDeal.rule_matched?.match.agent_profile, 'openclaw_agent');

    const nemoclawSmallDeal = await svc.evaluate(orgId, {
      agentId: nemoclaw!.id,
      tool: 'hubspot.deals.update',
      params: { properties: { amount: 15000 } },
    });
    assert.equal(nemoclawSmallDeal.effect, 'allow');
    assert.equal(
      nemoclawSmallDeal.rule_matched?.match.agent_profile,
      'nemoclaw_sandboxed_agent',
    );

    const nemoclawLargeDeal = await svc.evaluate(orgId, {
      agentId: nemoclaw!.id,
      tool: 'hubspot.deals.update',
      params: { properties: { amount: 82000 } },
    });
    assert.equal(nemoclawLargeDeal.effect, 'require_approval');
    assert.equal(
      nemoclawLargeDeal.rule_matched?.match.agent_profile,
      'nemoclaw_sandboxed_agent',
    );

    const openclawDelete = await svc.evaluate(orgId, {
      agentId: openclaw!.id,
      tool: 'hubspot.contacts.delete',
      params: {},
    });
    assert.equal(openclawDelete.effect, 'deny');
    assert.equal(openclawDelete.rule_matched?.match.agent_profile, 'openclaw_agent');
  });
});
