// Pure unit tests for SlackController.interactive — no Slack, no DB.
// Stubs the four collaborators (SlackService, ApprovalsService, AgentsService,
// ConfigService); the SlackSignatureGuard is unit-tested separately.

import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SlackController } from './slack.controller.js';
import type { Database } from '@agentbase/db';

// Resolves the Slack user's verified email to an approver in the org. The
// Slack signature proves the request came from Slack; this is what proves the
// human who clicked is allowed to decide.
function stubDb(role: 'admin' | 'approver' | 'viewer' = 'approver') {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            { id: 'u-1', email: 'slack-user@agentbase.test', role },
          ],
        }),
      }),
    }),
  };
}
import type { SlackService } from './slack.service.js';
import type { ApprovalsService } from '../approvals/approvals.service.js';
import type { AgentsService } from '../agents/agents.service.js';

interface DecideResult {
  approval_id: string;
  decision: 'approved' | 'denied';
  action_id: string;
  action_status: string;
  result: unknown;
}

class StubApprovals {
  decideCalls: {
    approvalId: string;
    decision: string;
    decidedByEmail?: string | undefined;
    notes?: string | undefined;
  }[] = [];
  decideResult: DecideResult = {
    approval_id: 'app-default',
    decision: 'approved',
    action_id: 'act-default',
    action_status: 'executed',
    result: null,
  };
  decideThrows: Error | null = null;
  getOneResult: { agent_name: string; tool: string } = {
    agent_name: 'stub-agent',
    tool: 'stub.tool',
  };
  getOneThrows: Error | null = null;

  async getOne() {
    if (this.getOneThrows) throw this.getOneThrows;
    return this.getOneResult as unknown as never;
  }

  async decide(input: {
    approvalId: string;
    orgId: string;
    decision: 'approve' | 'deny';
    decidedByEmail?: string;
    notes?: string;
  }): Promise<DecideResult> {
    this.decideCalls.push({
      approvalId: input.approvalId,
      decision: input.decision,
      decidedByEmail: input.decidedByEmail,
      notes: input.notes,
    });
    if (this.decideThrows) throw this.decideThrows;
    return this.decideResult;
  }
}

class StubAgents {
  async ensureDefaultOrg() {
    return 'default-org-id';
  }
}

class StubSlack {
  updateCalls: { url: string; text: string }[] = [];
  blocksBuilt: { decision: string; decidedByDisplay: string; tool: string }[] = [];

  async updateViaResponseUrl(url: string, _blocks: unknown, text: string) {
    this.updateCalls.push({ url, text });
  }

  buildResolvedBlocks(input: {
    decision: 'approved' | 'denied' | 'expired';
    decidedByDisplay: string;
    tool: string;
    agentName: string;
    actionStatus: string;
    errorCode: string | null;
    notes: string | null;
  }) {
    this.blocksBuilt.push({
      decision: input.decision,
      decidedByDisplay: input.decidedByDisplay,
      tool: input.tool,
    });
    return [];
  }
}

class FakeConfig {
  get<T = string>(_key: string): T | undefined {
    return undefined;
  }
}

function buildPayload(
  value: string,
  user: { id?: string; username?: string } = {},
): string {
  return JSON.stringify({
    type: 'block_actions',
    user: { id: user.id ?? 'U123', username: user.username ?? 'alice' },
    actions: [{ action_id: 'decide_x', block_id: 'b', value }],
    response_url: 'https://hooks.slack.com/test',
  });
}

describe('SlackController.interactive — payload validation', () => {
  let approvals: StubApprovals;
  let slack: StubSlack;
  let controller: SlackController;

  beforeEach(() => {
    approvals = new StubApprovals();
    slack = new StubSlack();
    controller = new SlackController(
      slack as unknown as SlackService,
      approvals as unknown as ApprovalsService,
      new StubAgents() as unknown as AgentsService,
      stubDb() as unknown as Database,
      new FakeConfig() as unknown as ConfigService,
    );
    // Slack's verified email is fetched from their API, which these tests do
    // not reach. Override the lookup so the mapping-and-role path is exercised
    // rather than short-circuited.
    (controller as unknown as {
      tryResolveEmail: (id: string) => Promise<string | null>;
    }).tryResolveEmail = async () => 'slack-user@agentbase.test';
  });

  it('returns ok:false on empty body', async () => {
    const r = await controller.interactive({} as { payload?: string });
    assert.deepEqual(r, { ok: false });
    assert.equal(approvals.decideCalls.length, 0);
  });

  it('returns ok:false on non-JSON payload', async () => {
    const r = await controller.interactive({ payload: 'not-json' });
    assert.deepEqual(r, { ok: false });
  });

  it('returns ok:false when actions array is empty', async () => {
    const r = await controller.interactive({
      payload: JSON.stringify({ user: { id: 'U' }, actions: [], response_url: '' }),
    });
    assert.deepEqual(r, { ok: false });
  });

  it('returns ok:false on button value with no colon', async () => {
    const r = await controller.interactive({ payload: buildPayload('justastring') });
    assert.deepEqual(r, { ok: false });
  });

  it('returns ok:false when decision word is unknown', async () => {
    const r = await controller.interactive({ payload: buildPayload('reject:app-1') });
    assert.deepEqual(r, { ok: false });
  });
});

describe('SlackController.interactive — happy paths', () => {
  let approvals: StubApprovals;
  let slack: StubSlack;
  let controller: SlackController;

  beforeEach(() => {
    approvals = new StubApprovals();
    slack = new StubSlack();
    controller = new SlackController(
      slack as unknown as SlackService,
      approvals as unknown as ApprovalsService,
      new StubAgents() as unknown as AgentsService,
      stubDb() as unknown as Database,
      new FakeConfig() as unknown as ConfigService,
    );
    // Slack's verified email is fetched from their API, which these tests do
    // not reach. Override the lookup so the mapping-and-role path is exercised
    // rather than short-circuited.
    (controller as unknown as {
      tryResolveEmail: (id: string) => Promise<string | null>;
    }).tryResolveEmail = async () => 'slack-user@agentbase.test';
  });

  it('approve calls decide with the right args and posts resolved blocks', async () => {
    approvals.decideResult = {
      approval_id: 'app-1',
      decision: 'approved',
      action_id: 'act-1',
      action_status: 'executed',
      result: null,
    };

    const r = await controller.interactive({
      payload: buildPayload('approve:app-1', { id: 'U999', username: 'alice' }),
    });
    assert.deepEqual(r, { ok: true });

    assert.equal(approvals.decideCalls.length, 1);
    assert.equal(approvals.decideCalls[0]!.decision, 'approve');
    assert.equal(approvals.decideCalls[0]!.approvalId, 'app-1');
    assert.match(approvals.decideCalls[0]!.notes ?? '', /alice/);

    assert.equal(slack.updateCalls.length, 1);
    assert.equal(slack.updateCalls[0]!.url, 'https://hooks.slack.com/test');
    assert.match(slack.updateCalls[0]!.text, /approved by alice/);

    assert.equal(slack.blocksBuilt.length, 1);
    assert.equal(slack.blocksBuilt[0]!.decision, 'approved');
    assert.match(slack.blocksBuilt[0]!.decidedByDisplay, /U999/);
    assert.equal(slack.blocksBuilt[0]!.tool, 'stub.tool');
  });

  it('deny passes "deny" to decide and renders denied blocks', async () => {
    approvals.decideResult = {
      approval_id: 'app-2',
      decision: 'denied',
      action_id: 'act-2',
      action_status: 'denied',
      result: null,
    };

    await controller.interactive({ payload: buildPayload('deny:app-2') });
    assert.equal(approvals.decideCalls[0]!.decision, 'deny');
    assert.equal(slack.blocksBuilt[0]!.decision, 'denied');
  });
});

describe('SlackController.interactive — error mapping', () => {
  let approvals: StubApprovals;
  let slack: StubSlack;
  let controller: SlackController;

  beforeEach(() => {
    approvals = new StubApprovals();
    slack = new StubSlack();
    controller = new SlackController(
      slack as unknown as SlackService,
      approvals as unknown as ApprovalsService,
      new StubAgents() as unknown as AgentsService,
      stubDb() as unknown as Database,
      new FakeConfig() as unknown as ConfigService,
    );
    // Slack's verified email is fetched from their API, which these tests do
    // not reach. Override the lookup so the mapping-and-role path is exercised
    // rather than short-circuited.
    (controller as unknown as {
      tryResolveEmail: (id: string) => Promise<string | null>;
    }).tryResolveEmail = async () => 'slack-user@agentbase.test';
  });

  it('ConflictException posts "no longer pending" via response_url', async () => {
    approvals.decideThrows = new ConflictException('approval already approved');
    const r = await controller.interactive({ payload: buildPayload('approve:x') });
    assert.deepEqual(r, { ok: true, already_decided: true });
    assert.equal(slack.updateCalls.length, 1);
    assert.match(slack.updateCalls[0]!.text, /no longer pending/i);
  });

  it('GoneException posts "expired" via response_url', async () => {
    approvals.decideThrows = new GoneException('approval expired');
    const r = await controller.interactive({ payload: buildPayload('approve:x') });
    assert.deepEqual(r, { ok: true, expired: true });
    assert.match(slack.updateCalls[0]!.text, /expired/i);
  });

  it('NotFoundException posts "not found" via response_url', async () => {
    approvals.decideThrows = new NotFoundException('approval not found');
    const r = await controller.interactive({ payload: buildPayload('approve:x') });
    assert.deepEqual(r, { ok: false, not_found: true });
    assert.match(slack.updateCalls[0]!.text, /not found/i);
  });

  it('unexpected errors propagate', async () => {
    approvals.decideThrows = new Error('boom');
    await assert.rejects(
      () => controller.interactive({ payload: buildPayload('approve:x') }),
      /boom/,
    );
  });

  it('tolerates getOne failure (continues with empty agent_name/tool)', async () => {
    approvals.getOneThrows = new NotFoundException('vanished');
    approvals.decideResult = {
      approval_id: 'app-9',
      decision: 'approved',
      action_id: 'act-9',
      action_status: 'executed',
      result: null,
    };
    const r = await controller.interactive({ payload: buildPayload('approve:app-9') });
    assert.deepEqual(r, { ok: true });
    assert.equal(slack.blocksBuilt[0]!.tool, '');
  });
});
