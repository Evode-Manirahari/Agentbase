import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  evaluatePolicy,
  matchesToolPattern,
  getByPath,
  FALLBACK_POLICY,
} from './policy-engine.js';
import {
  buildAgentPermissionProfilePolicyYaml,
  PolicyDocument,
  type PolicyRule,
} from '@agentbase/shared';
import { parse as parseYaml } from 'yaml';

const emptyDeny: PolicyDocument = { version: 1, default: 'deny', rules: [] };

function docWith(rule: PolicyRule, def: 'allow' | 'deny' = 'deny'): PolicyDocument {
  return { version: 1, default: def, rules: [rule] };
}

describe('matchesToolPattern', () => {
  it('exact matches', () => {
    assert.equal(matchesToolPattern('hubspot.contacts.update', 'hubspot.contacts.update'), true);
    assert.equal(matchesToolPattern('hubspot.contacts.update', 'hubspot.contacts.create'), false);
    assert.equal(matchesToolPattern('hubspot.contacts.update', 'salesforce.contacts.update'), false);
  });

  it('single wildcard', () => {
    assert.equal(matchesToolPattern('hubspot.*', 'hubspot.contacts.update'), true);
    assert.equal(matchesToolPattern('hubspot.*.update', 'hubspot.contacts.update'), true);
    assert.equal(matchesToolPattern('hubspot.*.update', 'salesforce.contacts.update'), false);
    assert.equal(matchesToolPattern('hubspot.*.update', 'hubspot.contacts.create'), false);
  });

  it('multiple wildcards', () => {
    assert.equal(matchesToolPattern('*.contacts.*', 'hubspot.contacts.update'), true);
    assert.equal(matchesToolPattern('*.contacts.*', 'hubspot.deals.update'), false);
    assert.equal(matchesToolPattern('*', 'anything.at.all'), true);
  });

  it('dot is literal, not a wildcard', () => {
    assert.equal(matchesToolPattern('foo.bar', 'fooXbar'), false);
    assert.equal(matchesToolPattern('foo.bar', 'foo.bar'), true);
  });

  it('trailing wildcard does not eat unrelated segments', () => {
    assert.equal(matchesToolPattern('hubspot.contacts.*', 'hubspot.deals.update'), false);
  });
});

describe('getByPath', () => {
  it('top-level key', () => {
    assert.equal(getByPath({ a: 1 }, 'a'), 1);
    assert.equal(getByPath({ a: 1 }, 'b'), undefined);
  });

  it('nested keys', () => {
    assert.equal(getByPath({ a: { b: { c: 'x' } } }, 'a.b.c'), 'x');
    assert.equal(getByPath({ a: { b: 0 } }, 'a.b'), 0);
  });

  it('returns undefined when intermediate is null/undefined/non-object', () => {
    assert.equal(getByPath({ a: null }, 'a.b'), undefined);
    assert.equal(getByPath({ a: undefined }, 'a.b'), undefined);
    assert.equal(getByPath({}, 'a.b.c'), undefined);
    assert.equal(getByPath({ a: 'string' }, 'a.b'), undefined);
    assert.equal(getByPath(null, 'a'), undefined);
  });

  it('empty path returns input', () => {
    const obj = { a: 1 };
    assert.equal(getByPath(obj, ''), obj);
  });
});

describe('evaluatePolicy — defaults', () => {
  it('empty rules + default deny returns deny', () => {
    const d = evaluatePolicy(emptyDeny, { tool: 'foo', params: {} });
    assert.equal(d.effect, 'deny');
    assert.equal(d.rule_index, null);
    assert.equal(d.rule_matched, null);
    assert.equal(d.fallback, false);
  });

  it('empty rules + default allow returns allow', () => {
    const doc: PolicyDocument = { version: 1, default: 'allow', rules: [] };
    assert.equal(evaluatePolicy(doc, { tool: 'foo', params: {} }).effect, 'allow');
  });

  it('FALLBACK_POLICY allows everything and carries fallback=true', () => {
    const d = evaluatePolicy(
      FALLBACK_POLICY,
      { tool: 'whatever.tool', params: {} },
      { isFallback: true },
    );
    assert.equal(d.effect, 'allow');
    assert.equal(d.fallback, true);
  });
});

describe('evaluatePolicy — rule precedence', () => {
  it('first matching rule wins', () => {
    const doc: PolicyDocument = {
      version: 1,
      default: 'deny',
      rules: [
        { match: { tool: 'foo' }, effect: 'allow' },
        { match: { tool: 'foo' }, effect: 'deny' },
      ],
    };
    const d = evaluatePolicy(doc, { tool: 'foo', params: {} });
    assert.equal(d.effect, 'allow');
    assert.equal(d.rule_index, 0);
  });

  it('falls through unmatched rules', () => {
    const doc: PolicyDocument = {
      version: 1,
      default: 'deny',
      rules: [
        { match: { tool: 'salesforce.*' }, effect: 'allow' },
        { match: { tool: 'hubspot.*' }, effect: 'allow' },
      ],
    };
    const d = evaluatePolicy(doc, { tool: 'hubspot.contacts.update', params: {} });
    assert.equal(d.rule_index, 1);
  });

  it('falls to default when no rule matches', () => {
    const doc: PolicyDocument = {
      version: 1,
      default: 'deny',
      rules: [{ match: { tool: 'salesforce.*' }, effect: 'allow' }],
    };
    const d = evaluatePolicy(doc, { tool: 'gmail.send', params: {} });
    assert.equal(d.effect, 'deny');
    assert.equal(d.rule_index, null);
  });
});

describe('evaluatePolicy — agent profile matching', () => {
  it('matches rules scoped to the current agent permission profile', () => {
    const doc = docWith({
      match: { tool: 'gmail.send', agent_profile: 'sales_sdr' },
      effect: 'require_approval',
      approver_role: 'approver',
    });
    const d = evaluatePolicy(doc, {
      tool: 'gmail.send',
      params: {},
      agent: {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'sdr-agent',
        permission_profile: 'sales_sdr',
      },
    });
    assert.equal(d.effect, 'require_approval');
    assert.equal(d.rule_index, 0);
  });

  it('falls through when an agent profile does not match', () => {
    const doc = docWith({
      match: { tool: 'gmail.send', agent_profile: 'sales_sdr' },
      effect: 'allow',
    });
    const d = evaluatePolicy(doc, {
      tool: 'gmail.send',
      params: {},
      agent: {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'analyst-agent',
        permission_profile: 'read_only_analyst',
      },
    });
    assert.equal(d.effect, 'deny');
    assert.equal(d.rule_index, null);
  });

  it('enforces first-class OpenClaw and NemoClaw profile thresholds', () => {
    const parsed = PolicyDocument.parse(
      parseYaml(buildAgentPermissionProfilePolicyYaml()),
    );

    const openclawLargeDeal = evaluatePolicy(parsed, {
      tool: 'hubspot.deals.update',
      params: { properties: { amount: 15000 } },
      agent: {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'openclaw',
        permission_profile: 'openclaw_agent',
      },
    });
    assert.equal(openclawLargeDeal.effect, 'require_approval');
    assert.equal(openclawLargeDeal.rule_matched?.match.agent_profile, 'openclaw_agent');

    const nemoclawSmallDeal = evaluatePolicy(parsed, {
      tool: 'hubspot.deals.update',
      params: { properties: { amount: 15000 } },
      agent: {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'nemoclaw',
        permission_profile: 'nemoclaw_sandboxed_agent',
      },
    });
    assert.equal(nemoclawSmallDeal.effect, 'allow');
    assert.equal(
      nemoclawSmallDeal.rule_matched?.match.agent_profile,
      'nemoclaw_sandboxed_agent',
    );

    const nemoclawLargeDeal = evaluatePolicy(parsed, {
      tool: 'hubspot.deals.update',
      params: { properties: { amount: 82000 } },
      agent: {
        id: '55555555-5555-4555-8555-555555555555',
        name: 'nemoclaw',
        permission_profile: 'nemoclaw_sandboxed_agent',
      },
    });
    assert.equal(nemoclawLargeDeal.effect, 'require_approval');

    const openclawDelete = evaluatePolicy(parsed, {
      tool: 'hubspot.contacts.delete',
      params: {},
      agent: {
        id: '66666666-6666-4666-8666-666666666666',
        name: 'openclaw',
        permission_profile: 'openclaw_agent',
      },
    });
    assert.equal(openclawDelete.effect, 'deny');
  });
});

describe('evaluatePolicy — when conditions', () => {
  it('literal value equality (string/number/bool/null)', () => {
    const num = docWith({ match: { tool: 'foo', when: { x: 5 } }, effect: 'allow' });
    assert.equal(evaluatePolicy(num, { tool: 'foo', params: { x: 5 } }).effect, 'allow');
    assert.equal(evaluatePolicy(num, { tool: 'foo', params: { x: 6 } }).effect, 'deny');

    const str = docWith({ match: { tool: 'foo', when: { stage: 'draft' } }, effect: 'allow' });
    assert.equal(evaluatePolicy(str, { tool: 'foo', params: { stage: 'draft' } }).effect, 'allow');
    assert.equal(evaluatePolicy(str, { tool: 'foo', params: { stage: 'closed' } }).effect, 'deny');

    const bool = docWith({ match: { tool: 'foo', when: { active: true } }, effect: 'allow' });
    assert.equal(evaluatePolicy(bool, { tool: 'foo', params: { active: true } }).effect, 'allow');
    assert.equal(evaluatePolicy(bool, { tool: 'foo', params: { active: false } }).effect, 'deny');

    const nul = docWith({ match: { tool: 'foo', when: { x: null } }, effect: 'allow' });
    assert.equal(evaluatePolicy(nul, { tool: 'foo', params: { x: null } }).effect, 'allow');
    assert.equal(evaluatePolicy(nul, { tool: 'foo', params: { x: 0 } }).effect, 'deny');
  });

  it('eq / neq operators', () => {
    const eq = docWith({ match: { tool: 'foo', when: { x: { eq: 'hello' } } }, effect: 'allow' });
    assert.equal(evaluatePolicy(eq, { tool: 'foo', params: { x: 'hello' } }).effect, 'allow');
    assert.equal(evaluatePolicy(eq, { tool: 'foo', params: { x: 'world' } }).effect, 'deny');

    const neq = docWith({ match: { tool: 'foo', when: { x: { neq: 5 } } }, effect: 'allow' });
    assert.equal(evaluatePolicy(neq, { tool: 'foo', params: { x: 5 } }).effect, 'deny');
    assert.equal(evaluatePolicy(neq, { tool: 'foo', params: { x: 6 } }).effect, 'allow');
  });

  it('gt / gte / lt / lte numeric comparisons', () => {
    const gt = docWith({ match: { tool: 'foo', when: { x: { gt: 10 } } }, effect: 'allow' });
    assert.equal(evaluatePolicy(gt, { tool: 'foo', params: { x: 11 } }).effect, 'allow');
    assert.equal(evaluatePolicy(gt, { tool: 'foo', params: { x: 10 } }).effect, 'deny');

    const gte = docWith({ match: { tool: 'foo', when: { x: { gte: 10 } } }, effect: 'allow' });
    assert.equal(evaluatePolicy(gte, { tool: 'foo', params: { x: 10 } }).effect, 'allow');
    assert.equal(evaluatePolicy(gte, { tool: 'foo', params: { x: 9 } }).effect, 'deny');

    const lt = docWith({ match: { tool: 'foo', when: { x: { lt: 10 } } }, effect: 'allow' });
    assert.equal(evaluatePolicy(lt, { tool: 'foo', params: { x: 9 } }).effect, 'allow');
    assert.equal(evaluatePolicy(lt, { tool: 'foo', params: { x: 10 } }).effect, 'deny');

    const lte = docWith({ match: { tool: 'foo', when: { x: { lte: 10 } } }, effect: 'allow' });
    assert.equal(evaluatePolicy(lte, { tool: 'foo', params: { x: 10 } }).effect, 'allow');
    assert.equal(evaluatePolicy(lte, { tool: 'foo', params: { x: 11 } }).effect, 'deny');
  });

  it('numeric comparisons fail safely on non-numeric values', () => {
    const gt = docWith({ match: { tool: 'foo', when: { x: { gt: 5 } } }, effect: 'allow' });
    assert.equal(evaluatePolicy(gt, { tool: 'foo', params: { x: 'string' } }).effect, 'deny');
    assert.equal(evaluatePolicy(gt, { tool: 'foo', params: {} }).effect, 'deny');
  });

  it('in operator', () => {
    const doc = docWith({
      match: { tool: 'foo', when: { stage: { in: ['draft', 'review'] } } },
      effect: 'allow',
    });
    assert.equal(evaluatePolicy(doc, { tool: 'foo', params: { stage: 'draft' } }).effect, 'allow');
    assert.equal(evaluatePolicy(doc, { tool: 'foo', params: { stage: 'review' } }).effect, 'allow');
    assert.equal(evaluatePolicy(doc, { tool: 'foo', params: { stage: 'closed' } }).effect, 'deny');
  });

  it('contains on string and array', () => {
    const onString = docWith({
      match: { tool: 'foo', when: { email: { contains: '@partner.com' } } },
      effect: 'allow',
    });
    assert.equal(
      evaluatePolicy(onString, { tool: 'foo', params: { email: 'a@partner.com' } }).effect,
      'allow',
    );
    assert.equal(
      evaluatePolicy(onString, { tool: 'foo', params: { email: 'a@example.com' } }).effect,
      'deny',
    );

    const onArr = docWith({
      match: { tool: 'foo', when: { tags: { contains: 'urgent' } } },
      effect: 'allow',
    });
    assert.equal(
      evaluatePolicy(onArr, { tool: 'foo', params: { tags: ['urgent', 'closed'] } }).effect,
      'allow',
    );
    assert.equal(
      evaluatePolicy(onArr, { tool: 'foo', params: { tags: ['cold'] } }).effect,
      'deny',
    );
  });

  it('exists true/false', () => {
    const yes = docWith({
      match: { tool: 'foo', when: { x: { exists: true } } },
      effect: 'allow',
    });
    assert.equal(evaluatePolicy(yes, { tool: 'foo', params: { x: null } }).effect, 'allow');
    assert.equal(evaluatePolicy(yes, { tool: 'foo', params: { x: 0 } }).effect, 'allow');
    assert.equal(evaluatePolicy(yes, { tool: 'foo', params: {} }).effect, 'deny');

    const no = docWith({
      match: { tool: 'foo', when: { x: { exists: false } } },
      effect: 'allow',
    });
    assert.equal(evaluatePolicy(no, { tool: 'foo', params: {} }).effect, 'allow');
    assert.equal(evaluatePolicy(no, { tool: 'foo', params: { x: 1 } }).effect, 'deny');
  });

  it('all conditions on a rule must pass (logical AND)', () => {
    const doc = docWith({
      match: {
        tool: 'foo',
        when: { 'a.b': { gt: 10 }, stage: { in: ['draft'] } },
      },
      effect: 'allow',
    });
    assert.equal(
      evaluatePolicy(doc, { tool: 'foo', params: { a: { b: 11 }, stage: 'draft' } }).effect,
      'allow',
    );
    assert.equal(
      evaluatePolicy(doc, { tool: 'foo', params: { a: { b: 11 }, stage: 'closed' } }).effect,
      'deny',
    );
    assert.equal(
      evaluatePolicy(doc, { tool: 'foo', params: { a: { b: 5 }, stage: 'draft' } }).effect,
      'deny',
    );
  });

  it('dotted path resolution into nested params', () => {
    const doc = docWith({
      match: { tool: 'foo', when: { 'properties.amount': { gt: 100 } } },
      effect: 'allow',
    });
    assert.equal(
      evaluatePolicy(doc, { tool: 'foo', params: { properties: { amount: 200 } } }).effect,
      'allow',
    );
    assert.equal(
      evaluatePolicy(doc, { tool: 'foo', params: { properties: { amount: 50 } } }).effect,
      'deny',
    );
    assert.equal(evaluatePolicy(doc, { tool: 'foo', params: {} }).effect, 'deny');
  });
});

describe('evaluatePolicy — decision shape', () => {
  it('populates rule_index, rule_matched, approver_role, reason on match', () => {
    const rule: PolicyRule = {
      match: { tool: 'foo' },
      effect: 'require_approval',
      approver_role: 'approver',
      reason: 'sensitive',
      slack_channel: '#critical',
    };
    const doc: PolicyDocument = { version: 1, default: 'deny', rules: [rule] };
    const d = evaluatePolicy(doc, { tool: 'foo', params: {} });
    assert.equal(d.effect, 'require_approval');
    assert.equal(d.rule_index, 0);
    assert.deepEqual(d.rule_matched, rule);
    assert.equal(d.reason, 'sensitive');
    assert.equal(d.approver_role, 'approver');
  });

  it('synthesises a reason when the rule omits one', () => {
    const doc = docWith({ match: { tool: 'foo' }, effect: 'allow' });
    const d = evaluatePolicy(doc, { tool: 'foo', params: {} });
    assert.match(d.reason ?? '', /matched rule\[0\]/);
  });

  it('passes opts.policyId and opts.isFallback through', () => {
    const d = evaluatePolicy(
      emptyDeny,
      { tool: 'foo', params: {} },
      { policyId: 'pol-abc', isFallback: false },
    );
    assert.equal(d.policy_id, 'pol-abc');
    assert.equal(d.fallback, false);
  });
});
