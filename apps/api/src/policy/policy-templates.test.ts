import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parse as parseYaml } from 'yaml';
import {
  POLICY_TEMPLATES,
  PolicyDocument,
  policyTemplateRulesYaml,
  policyTemplateStandaloneYaml,
  type PolicyTemplate,
  type PolicyTemplateKey,
} from '@dejavas/shared';
import { evaluatePolicy } from './policy-engine.js';

function findTemplate(key: PolicyTemplateKey): PolicyTemplate {
  const t = POLICY_TEMPLATES.find((x) => x.key === key);
  assert.ok(t, `template ${key} should exist`);
  return t;
}

function standaloneDoc(template: PolicyTemplate): PolicyDocument {
  const parsed = PolicyDocument.safeParse(parseYaml(policyTemplateStandaloneYaml(template)));
  assert.ok(parsed.success, `standalone YAML for ${template.key} should validate`);
  return parsed.data;
}

describe('POLICY_TEMPLATES catalog', () => {
  it('exposes the three Week 1 templates with unique keys', () => {
    const keys = POLICY_TEMPLATES.map((t) => t.key);
    assert.deepEqual(
      [...keys].sort(),
      [
        'approval-before-external-email',
        'approval-before-high-value-crm-write',
        'deny-destructive-and-bulk',
      ].sort(),
    );
    assert.equal(new Set(keys).size, keys.length, 'template keys must be unique');
  });

  it('every template has a non-empty label, description, and at least one rule', () => {
    for (const t of POLICY_TEMPLATES) {
      assert.ok(t.label.length > 0, `${t.key}: label`);
      assert.ok(t.description.length > 0, `${t.key}: description`);
      assert.ok(t.rules.length > 0, `${t.key}: rules`);
    }
  });
});

describe('policyTemplateRulesYaml', () => {
  it('produces YAML that parses as a valid rules array under PolicyDocument', () => {
    for (const template of POLICY_TEMPLATES) {
      const doc = standaloneDoc(template);
      assert.equal(doc.rules.length, template.rules.length, template.key);
    }
  });

  it('rules block can be concatenated under an existing rules: header', () => {
    const template = findTemplate('deny-destructive-and-bulk');
    const yaml = `version: 1\ndefault: allow\nrules:\n${policyTemplateRulesYaml(template)
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')}`;
    const parsed = PolicyDocument.safeParse(parseYaml(yaml));
    assert.ok(parsed.success, 'concatenation should produce a valid PolicyDocument');
    assert.equal(parsed.data.rules.length, template.rules.length);
  });
});

describe('approval-before-external-email template', () => {
  const doc = standaloneDoc(findTemplate('approval-before-external-email'));

  it('allows drafting an email', () => {
    const decision = evaluatePolicy(doc, {
      tool: 'gmail.draft.create',
      params: { to: 'lead@acme.com', subject: 'hi' },
    });
    assert.equal(decision.effect, 'allow');
  });

  it('requires approval for gmail.send', () => {
    const decision = evaluatePolicy(doc, {
      tool: 'gmail.send',
      params: { to: 'lead@acme.com' },
    });
    assert.equal(decision.effect, 'require_approval');
    assert.equal(decision.approver_role, 'approver');
    assert.equal(decision.rule_matched?.slack_channel, '#agent-approvals');
  });

  it('requires approval for gmail.draft.send', () => {
    const decision = evaluatePolicy(doc, {
      tool: 'gmail.draft.send',
      params: { draft_id: 'abc' },
    });
    assert.equal(decision.effect, 'require_approval');
  });

  it('falls back to default deny for unrelated tools', () => {
    const decision = evaluatePolicy(doc, {
      tool: 'hubspot.contacts.update',
      params: {},
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.rule_index, null);
  });
});

describe('approval-before-high-value-crm-write template', () => {
  const doc = standaloneDoc(findTemplate('approval-before-high-value-crm-write'));

  it('requires approval on HubSpot deal updates >= $10k', () => {
    const decision = evaluatePolicy(doc, {
      tool: 'hubspot.deals.update',
      params: { properties: { amount: 25000 } },
    });
    assert.equal(decision.effect, 'require_approval');
    assert.equal(decision.rule_matched?.slack_channel, '#critical-approvals');
  });

  it('allows HubSpot CRM writes below threshold', () => {
    const cases = [
      {
        tool: 'hubspot.deals.update',
        params: { properties: { amount: 500 } },
      },
      {
        tool: 'hubspot.deals.create',
        params: { properties: { amount: 500 } },
      },
      {
        tool: 'hubspot.leads.create_deal',
        params: { deal: { amount: 500 } },
      },
    ];
    for (const c of cases) {
      const decision = evaluatePolicy(doc, c);
      assert.equal(decision.effect, 'allow', c.tool);
    }
  });

  it('matches the lead-to-deal workflow with deal.amount nesting', () => {
    const decision = evaluatePolicy(doc, {
      tool: 'hubspot.leads.create_deal',
      params: { deal: { amount: 15000 } },
    });
    assert.equal(decision.effect, 'require_approval');
  });

  it('requires approval on Salesforce opportunity updates >= $10k', () => {
    const decision = evaluatePolicy(doc, {
      tool: 'salesforce.opportunity.update',
      params: { fields: { Amount: 50000 } },
    });
    assert.equal(decision.effect, 'require_approval');
  });

  it('requires approval on Salesforce opportunity create >= $10k', () => {
    const decision = evaluatePolicy(doc, {
      tool: 'salesforce.opportunity.create',
      params: { fields: { Amount: 12000 } },
    });
    assert.equal(decision.effect, 'require_approval');
  });

  it('allows Salesforce opportunity writes below threshold', () => {
    for (const tool of [
      'salesforce.opportunity.update',
      'salesforce.opportunity.create',
    ]) {
      const decision = evaluatePolicy(doc, {
        tool,
        params: { fields: { Amount: 2500 } },
      });
      assert.equal(decision.effect, 'allow', tool);
    }
  });
});

describe('deny-destructive-and-bulk template', () => {
  const doc = standaloneDoc(findTemplate('deny-destructive-and-bulk'));

  it('denies any *.delete tool', () => {
    for (const tool of [
      'hubspot.contacts.delete',
      'salesforce.opportunity.delete',
      'outreach.prospects.delete',
    ]) {
      const decision = evaluatePolicy(doc, { tool, params: {} });
      assert.equal(decision.effect, 'deny', tool);
    }
  });

  it('denies any *.export tool', () => {
    const decision = evaluatePolicy(doc, {
      tool: 'hubspot.contacts.export',
      params: {},
    });
    assert.equal(decision.effect, 'deny');
  });

  it('denies bulk and bulk_* tools', () => {
    for (const tool of [
      'salesforce.opportunity.bulk',
      'hubspot.contacts.bulk_update',
      'hubspot.deals.bulk_delete',
    ]) {
      const decision = evaluatePolicy(doc, { tool, params: {} });
      assert.equal(decision.effect, 'deny', tool);
    }
  });

  it('does not match unrelated read or write tools', () => {
    const decision = evaluatePolicy(doc, {
      tool: 'hubspot.contacts.update',
      params: {},
    });
    assert.equal(decision.effect, 'deny', 'falls through to default deny');
    assert.equal(decision.rule_index, null);
  });
});
