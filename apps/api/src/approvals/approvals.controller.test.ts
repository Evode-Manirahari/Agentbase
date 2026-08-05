// Pure unit tests for ApprovalsController — no DB. Stubs ApprovalsService and
// AgentsService; asserts org resolution, limit clamping, and passthrough of
// decision payloads. The guard is unit-tested in ../auth/clerk-auth.guard.test.ts.

import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { ApprovalsController } from './approvals.controller.js';
import type { Database } from '@agentbase/db';
import type { ApprovalsService } from './approvals.service.js';
import type { AgentsService } from '../agents/agents.service.js';

const APPROVAL_UUID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

class StubApprovals {
  listCalls: { orgId: string; limit: number }[] = [];
  getOneCalls: { orgId: string; approvalId: string }[] = [];
  decideCalls: Record<string, unknown>[] = [];
  bulkCalls: Record<string, unknown>[] = [];

  async list(orgId: string, limit: number) {
    this.listCalls.push({ orgId, limit });
    return { items: [] };
  }

  async getOne(orgId: string, approvalId: string) {
    this.getOneCalls.push({ orgId, approvalId });
    return { approval_id: approvalId } as unknown as never;
  }

  async decide(input: Record<string, unknown>) {
    this.decideCalls.push(input);
    return {
      approval_id: input.approvalId,
      decision: 'approved' as const,
      action_id: 'act-1',
      action_status: 'executed' as const,
      result: { ok: true, data: null },
    };
  }

  async bulkDecide(input: Record<string, unknown>) {
    this.bulkCalls.push(input);
    return {
      items: [],
      summary: { decided: 0, skipped_already_decided: 0, failed: 0 },
    };
  }
}

class StubAgents {
  async ensureDefaultOrg() {
    return 'org-default';
  }
}

describe('ApprovalsController', () => {
  let stub: StubApprovals;
  let controller: ApprovalsController;

  beforeEach(() => {
    stub = new StubApprovals();
    controller = new ApprovalsController(
      stub as unknown as ApprovalsService,
      new StubAgents() as unknown as AgentsService,
      // Unused in these tests: without a verified session resolveActor()
      // returns the dev-passthrough actor before it ever touches the database.
      null as unknown as Database,
    );
  });

  it('list: defaults limit to 100 under the default org', async () => {
    await controller.list(undefined);
    assert.deepEqual(stub.listCalls, [{ orgId: 'org-default', limit: 100 }]);
  });

  it('list: clamps limit into [1, 500]', async () => {
    await controller.list('10000');
    await controller.list('-3');
    assert.equal(stub.listCalls[0]!.limit, 500);
    assert.equal(stub.listCalls[1]!.limit, 1);
  });

  it('list: falls back to 100 on a non-numeric limit instead of passing NaN to SQL', async () => {
    await controller.list('abc');
    assert.equal(stub.listCalls[0]!.limit, 100);
  });

  it('getOne: scopes the lookup to the default org', async () => {
    await controller.getOne(APPROVAL_UUID);
    assert.deepEqual(stub.getOneCalls, [
      { orgId: 'org-default', approvalId: APPROVAL_UUID },
    ]);
  });

  it('decide: passes decision, email, and notes through to the service', async () => {
    const out = await controller.decide(
      APPROVAL_UUID,
      { decision: 'deny', notes: 'looks risky' },
      {} as never,
    );

    // The decider is no longer anything the caller sent. Without a verified
    // session this is the dev-passthrough actor; in enforced mode it is the
    // Clerk user resolved to a row in this org.
    assert.equal(stub.decideCalls.length, 1);
    const call = stub.decideCalls[0]!;
    assert.equal(call.approvalId, APPROVAL_UUID);
    assert.equal(call.orgId, 'org-default');
    assert.equal(call.decision, 'deny');
    assert.equal(call.notes, 'looks risky');
    assert.equal((call.actor as { devPassthrough: boolean }).devPassthrough, true);
    assert.equal(
      (call as unknown as { decidedByEmail?: string }).decidedByEmail,
      undefined,
      'a caller-supplied decider must not survive anywhere in the call',
    );
    assert.equal(out.approval_id, APPROVAL_UUID);
  });

  it('bulkDecide: passes the id list and decision through to the service', async () => {
    const ids = [APPROVAL_UUID, '1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809'];
    await controller.bulkDecide(
      { approval_ids: ids, decision: 'approve' },
      {} as never,
    );

    assert.equal(stub.bulkCalls.length, 1);
    assert.deepEqual(stub.bulkCalls[0]!.approvalIds, ids);
    assert.equal(stub.bulkCalls[0]!.decision, 'approve');
    assert.equal(stub.bulkCalls[0]!.orgId, 'org-default');
  });
});
