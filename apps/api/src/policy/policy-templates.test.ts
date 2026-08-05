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
} from '@agentbase/shared';
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
  it('exposes the shipped templates with unique keys', () => {
    const keys = POLICY_TEMPLATES.map((t) => t.key);
    assert.deepEqual(
      [...keys].sort(),
      [
        'approval-before-irreversible-effects',
        'approval-before-external-email',
        'approval-before-high-value-crm-write',
        'deny-destructive-and-bulk',
      ].sort(),
    );
    assert.equal(new Set(keys).size, keys.length, 'template keys must be unique');
  });

  it('the effect template is offered first', () => {
    // The tool-enumerating templates go stale the moment an agent learns a
    // command nobody listed. The effect one does not, so it is the default a
    // reader sees.
    assert.equal(POLICY_TEMPLATES[0]?.key, 'approval-before-irreversible-effects');
  });

  it('the effect template denies unknown BEFORE the irreversible rule', () => {
    // Load-bearing ordering, and the reason is not obvious: `unknown` carries
    // reversible:false, so if the irreversible rule came first, an unreadable
    // command like `curl … | sh` would be queued for human approval instead of
    // refused — routing a command nobody can read to a person who also cannot
    // read it.
    const t = POLICY_TEMPLATES.find(
      (x) => x.key === 'approval-before-irreversible-effects',
    );
    assert.ok(t);
    const unknownIdx = t!.rules.findIndex(
      (r) => r.match.effect_class === 'unknown',
    );
    const irreversibleIdx = t!.rules.findIndex(
      (r) => r.match.reversible === false && r.match.effect_class === undefined,
    );
    assert.ok(unknownIdx >= 0, 'has an unknown rule');
    assert.ok(irreversibleIdx >= 0, 'has an irreversible rule');
    assert.ok(
      unknownIdx < irreversibleIdx,
      'unknown must be denied before the irreversible rule can match it',
    );
    assert.equal(t!.rules[unknownIdx]!.effect, 'deny');
  });

  it('the effect template names no tool, so it cannot go stale', () => {
    const t = POLICY_TEMPLATES.find(
      (x) => x.key === 'approval-before-irreversible-effects',
    );
    for (const r of t!.rules) {
      assert.equal(r.match.tool, '*', 'every rule matches on effect, not tool name');
    }
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

  it('preserves nested object and array condition values', () => {
    const template: PolicyTemplate = {
      key: 'deny-destructive-and-bulk',
      label: 'Nested condition values',
      description: 'Exercises object values in generated YAML.',
      rules: [
        {
          match: {
            tool: 'hubspot.contacts.update',
            when: {
              metadata: {
                eq: {
                  source: 'csv',
                  tags: ['vip', 'renewal'],
                },
              },
            },
          },
          effect: 'deny',
        },
      ],
    };
    const doc = standaloneDoc(template);
    assert.deepEqual(doc.rules[0]?.match.when?.metadata, {
      eq: { source: 'csv', tags: ['vip', 'renewal'] },
    });
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

// The ordering assertions above compare rule indices. These evaluate the
// template as a policy document, which is what actually decides — an index
// check would still pass if the engine ignored effect predicates entirely.
describe('approval-before-irreversible-effects — behaviour', () => {
  const doc = standaloneDoc(findTemplate('approval-before-irreversible-effects'));

  function decide(
    effectClass: string,
    reversible: boolean,
    tool = 'shell.run',
  ) {
    return evaluatePolicy(doc, {
      tool,
      params: {},
      effect: { effectClass: effectClass as never, reversible },
    }).effect;
  }

  it('an unreadable command is DENIED, not queued for a human', () => {
    assert.equal(decide('unknown', false), 'deny');
  });

  it('every irreversible effect stops for a human', () => {
    for (const c of [
      'publish',
      'deploy',
      'infra_write',
      'vcs_write',
      'egress',
      'external_comms',
    ]) {
      assert.equal(decide(c, false), 'require_approval', c);
    }
  });

  it('reads and recoverable edits run unattended', () => {
    assert.equal(decide('read', true), 'allow');
    assert.equal(decide('workspace_write', true), 'allow');
  });

  it('an irreversible workspace write still stops — rm is not recoverable', () => {
    assert.equal(decide('workspace_write', false), 'require_approval');
  });

  it('an unclassified action falls through to the document default', () => {
    // No effect predicate matches without an assessment, so this lands on
    // `default: deny` rather than being quietly permitted.
    assert.equal(
      evaluatePolicy(doc, { tool: 'hubspot.deals.update', params: {} }).effect,
      'deny',
    );
  });

  it('the template works for any tool, not just shell', () => {
    assert.equal(decide('publish', false, 'some.future.tool'), 'require_approval');
  });
});

// Regression guard for the serializer. It emitted only `tool` and `when`, so
// any other match predicate was dropped on the way to YAML. That does not
// fail loudly — it WIDENS the rule. `{tool:'*', effect_class:'unknown'} → deny`
// became `{tool:'*'} → deny`, a policy that denies everything and looks
// plausible in the editor.
describe('template YAML preserves every match predicate', () => {
  it('round-trips effect_class and reversible', () => {
    const t = findTemplate('approval-before-irreversible-effects');
    const yaml = policyTemplateStandaloneYaml(t);
    assert.match(yaml, /effect_class: unknown/);
    assert.match(yaml, /effect_class: read/);
    assert.match(yaml, /reversible: false/);
    assert.match(yaml, /reversible: true/);

    const parsed = PolicyDocument.safeParse(parseYaml(yaml));
    assert.ok(parsed.success);
    const rules = parsed.data.rules;
    assert.equal(rules[0]?.match.effect_class, 'unknown');
    assert.equal(rules[2]?.match.reversible, false);
  });

  it('no rule loses a predicate between the object and the YAML', () => {
    for (const t of POLICY_TEMPLATES) {
      const parsed = PolicyDocument.safeParse(
        parseYaml(policyTemplateStandaloneYaml(t)),
      );
      assert.ok(parsed.success, `${t.key} parses`);
      assert.equal(parsed.data.rules.length, t.rules.length, `${t.key} rule count`);
      t.rules.forEach((src, i) => {
        const out = parsed.data.rules[i]!;
        assert.deepEqual(
          Object.keys(src.match).sort(),
          Object.keys(out.match).sort(),
          `${t.key} rule[${i}] match keys survive serialisation`,
        );
      });
    }
  });
});
