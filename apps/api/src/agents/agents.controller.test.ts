// Pure unit tests for AgentsController — no DB, no Clerk. Stubs AgentsService
// and asserts the controller's own responsibilities: org resolution, limit
// clamping, wire-shape mapping, and actor attribution. The ClerkAuthGuard
// itself is unit-tested in ../auth/clerk-auth.guard.test.ts.

import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { FastifyRequest } from 'fastify';
import { AgentsController } from './agents.controller.js';
import type { AgentsService } from './agents.service.js';

type ListRow = {
  id: string;
  name: string;
  description: string | null;
  permissionProfile: string;
  status: string;
  createdAt: Date;
  revokedAt: Date | null;
  keyPrefix: string | null;
};

class StubAgents {
  listCalls: { orgId: string; limit: number }[] = [];
  listRows: ListRow[] = [];
  registerCalls: Record<string, unknown>[] = [];
  updateCalls: Record<string, unknown>[] = [];
  revokeCalls: Record<string, unknown>[] = [];

  async ensureDefaultOrg() {
    return 'org-default';
  }

  async listForOrg(orgId: string, limit: number) {
    this.listCalls.push({ orgId, limit });
    return this.listRows;
  }

  async register(input: Record<string, unknown>) {
    this.registerCalls.push(input);
    return {
      agent_id: 'agent-1',
      api_key: 'agb_secret',
      api_key_prefix: 'agb_secret'.slice(0, 12),
      permission_profile: 'sales_sdr' as const,
    };
  }

  async updatePermissionProfile(input: Record<string, unknown>) {
    this.updateCalls.push(input);
    return { id: input.agentId, permissionProfile: input.permissionProfile };
  }

  async revoke(input: Record<string, unknown>) {
    this.revokeCalls.push(input);
    return {
      agent_id: input.agentId,
      status: 'revoked' as const,
      revoked_at: new Date().toISOString(),
      keys_revoked: 1,
      already_revoked: false,
    };
  }
}

const AGENT_UUID = '5b3385b8-9158-4d27-bd4c-4571f9a3d9a2';

describe('AgentsController.list', () => {
  let stub: StubAgents;
  let controller: AgentsController;

  beforeEach(() => {
    stub = new StubAgents();
    controller = new AgentsController(stub as unknown as AgentsService);
  });

  it('defaults limit to 100 and resolves the default org', async () => {
    await controller.list(undefined);
    assert.deepEqual(stub.listCalls, [{ orgId: 'org-default', limit: 100 }]);
  });

  it('clamps limit into [1, 500]', async () => {
    await controller.list('9999');
    await controller.list('0');
    assert.equal(stub.listCalls[0]!.limit, 500);
    assert.equal(stub.listCalls[1]!.limit, 1);
  });

  it('falls back to 100 on a non-numeric limit instead of passing NaN to SQL', async () => {
    await controller.list('abc');
    assert.equal(stub.listCalls[0]!.limit, 100);
  });

  it('maps rows to the wire shape with ISO dates', async () => {
    const createdAt = new Date('2026-01-02T03:04:05.000Z');
    const revokedAt = new Date('2026-02-03T04:05:06.000Z');
    stub.listRows = [
      {
        id: 'a1',
        name: 'researcher',
        description: 'looks things up',
        permissionProfile: 'read_only_analyst',
        status: 'revoked',
        createdAt,
        revokedAt,
        keyPrefix: 'agb_abcd1234',
      },
    ];

    const out = await controller.list(undefined);
    assert.deepEqual(out.items, [
      {
        id: 'a1',
        name: 'researcher',
        description: 'looks things up',
        permission_profile: 'read_only_analyst',
        status: 'revoked',
        created_at: '2026-01-02T03:04:05.000Z',
        revoked_at: '2026-02-03T04:05:06.000Z',
        api_key_prefix: 'agb_abcd1234',
      },
    ]);
  });

  it("maps an unknown stored profile to 'custom' instead of leaking raw DB values", async () => {
    stub.listRows = [
      {
        id: 'a2',
        name: 'legacy',
        description: null,
        permissionProfile: 'some_legacy_profile',
        status: 'active',
        createdAt: new Date(),
        revokedAt: null,
        keyPrefix: null,
      },
    ];

    const out = await controller.list(undefined);
    assert.equal(out.items[0]!.permission_profile, 'custom');
    assert.equal(out.items[0]!.revoked_at, null);
    assert.equal(out.items[0]!.api_key_prefix, null);
  });
});

describe('AgentsController.register', () => {
  it('passes body fields through to the service under the default org', async () => {
    const stub = new StubAgents();
    const controller = new AgentsController(stub as unknown as AgentsService);

    const out = await controller.register({
      name: 'sdr-bot',
      description: 'sends follow-ups',
      permission_profile: 'sales_sdr',
    });

    assert.deepEqual(stub.registerCalls, [
      {
        orgId: 'org-default',
        name: 'sdr-bot',
        description: 'sends follow-ups',
        permissionProfile: 'sales_sdr',
      },
    ]);
    assert.equal(out.agent_id, 'agent-1');
    assert.match(out.api_key, /^agb_/);
  });
});

describe('AgentsController.updatePermissionProfile', () => {
  it('attributes the change to the Clerk user when present', async () => {
    const stub = new StubAgents();
    const controller = new AgentsController(stub as unknown as AgentsService);
    const req = {
      clerkUser: { userId: 'user_42', sessionId: null },
    } as unknown as FastifyRequest;

    const out = await controller.updatePermissionProfile(req, AGENT_UUID, {
      permission_profile: 'support_agent',
    });

    assert.deepEqual(stub.updateCalls, [
      {
        orgId: 'org-default',
        agentId: AGENT_UUID,
        permissionProfile: 'support_agent',
        actorId: 'user_42',
      },
    ]);
    assert.deepEqual(out, { id: AGENT_UUID, permission_profile: 'support_agent' });
  });

  it("falls back to 'dev-mode-operator' when there is no Clerk user (dev passthrough)", async () => {
    const stub = new StubAgents();
    const controller = new AgentsController(stub as unknown as AgentsService);
    const req = {} as FastifyRequest;

    await controller.updatePermissionProfile(req, AGENT_UUID, {
      permission_profile: 'revops_admin',
    });

    assert.equal(stub.updateCalls[0]!.actorId, 'dev-mode-operator');
  });
});

describe('AgentsController.revoke', () => {
  it('passes reason and revoked_by_email through to the service', async () => {
    const stub = new StubAgents();
    const controller = new AgentsController(stub as unknown as AgentsService);

    const out = await controller.revoke(AGENT_UUID, {
      reason: 'rotating credentials',
      revoked_by_email: 'ops@agentbase.test',
    });

    assert.deepEqual(stub.revokeCalls, [
      {
        orgId: 'org-default',
        agentId: AGENT_UUID,
        reason: 'rotating credentials',
        revokedByEmail: 'ops@agentbase.test',
      },
    ]);
    assert.equal(out.status, 'revoked');
  });
});
