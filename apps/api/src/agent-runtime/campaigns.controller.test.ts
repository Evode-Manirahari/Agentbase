import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { BadRequestException } from '@nestjs/common';
import { CampaignsController } from './campaigns.controller.js';
import { JobRegistry } from './job.js';
import { AI_SDR_OUTBOUND_JOB } from './jobs/ai-sdr-outbound.js';
import type { AgentRunsService, RunRow } from './agent-runs.service.js';
import type { AgentsService } from '../agents/agents.service.js';

function makeRegistry(): JobRegistry {
  const r = new JobRegistry();
  r.register(AI_SDR_OUTBOUND_JOB);
  return r;
}

interface CreateCall {
  input: Parameters<AgentRunsService['create']>[0];
}

function makeController(opts: {
  registry?: JobRegistry;
  orgId?: string;
  existingRow?: Partial<RunRow>;
} = {}): {
  controller: CampaignsController;
  createCalls: CreateCall[];
  getCalls: string[];
} {
  const registry = opts.registry ?? makeRegistry();
  const createCalls: CreateCall[] = [];
  const getCalls: string[] = [];

  const stubRow = (id: string): RunRow => ({
    id,
    org_id: opts.orgId ?? '00000000-0000-0000-0000-0000000000aa',
    agent_id: '11111111-1111-1111-1111-111111111111',
    job_key: 'ai-sdr-outbound',
    context: {},
    status: 'pending',
    transcript: [],
    messages: [],
    paused_on_action_id: null,
    paused_on_tool_use_id: null,
    paused_on_dejavas_tool: null,
    usage: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    ...opts.existingRow,
  });

  const runs: Pick<AgentRunsService, 'create' | 'get' | 'listForOrg'> = {
    async create(input) {
      createCalls.push({ input });
      return stubRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    },
    async get(_orgId, id) {
      getCalls.push(id);
      return stubRow(id);
    },
    async listForOrg() {
      return [stubRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')];
    },
  };

  const agents: Pick<AgentsService, 'ensureDefaultOrg'> = {
    async ensureDefaultOrg() {
      return opts.orgId ?? '00000000-0000-0000-0000-0000000000aa';
    },
  };

  return {
    controller: new CampaignsController(
      runs as AgentRunsService,
      registry,
      agents as AgentsService,
    ),
    createCalls,
    getCalls,
  };
}

describe('CampaignsController.jobs', () => {
  it('lists every registered job', () => {
    const { controller } = makeController();
    const out = controller.jobs();
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0]?.key, 'ai-sdr-outbound');
    assert.ok(out.items[0]?.tools.some((t) => t.dejavas_tool === 'gmail.send'));
  });
});

describe('CampaignsController.createRun', () => {
  it('enqueues the run with resolved orgId and returns the pending row', async () => {
    const { controller, createCalls } = makeController();
    const out = await controller.createRun({
      job_key: 'ai-sdr-outbound',
      agent_id: '22222222-2222-2222-2222-222222222222',
      context: { email: 'lead@acme.com' },
    });
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0]?.input.jobKey, 'ai-sdr-outbound');
    assert.equal(
      createCalls[0]?.input.agentId,
      '22222222-2222-2222-2222-222222222222',
    );
    assert.deepEqual(createCalls[0]?.input.context, { email: 'lead@acme.com' });
    assert.equal(
      createCalls[0]?.input.orgId,
      '00000000-0000-0000-0000-0000000000aa',
    );
    assert.equal(out.status, 'pending');
    assert.equal(out.paused_on, null);
  });

  it('rejects unknown job keys before enqueueing', async () => {
    const { controller, createCalls } = makeController();
    await assert.rejects(
      () =>
        controller.createRun({
          job_key: 'does-not-exist',
          agent_id: '22222222-2222-2222-2222-222222222222',
          context: {},
        }),
      BadRequestException,
    );
    assert.equal(createCalls.length, 0);
  });
});

describe('CampaignsController.getRun', () => {
  it('hydrates paused_on metadata into a nested object', async () => {
    const { controller } = makeController({
      existingRow: {
        status: 'paused',
        paused_on_action_id: '33333333-3333-3333-3333-333333333333',
        paused_on_tool_use_id: 'tu_xyz',
        paused_on_dejavas_tool: 'gmail.send',
      },
    });
    const out = await controller.getRun('44444444-4444-4444-4444-444444444444');
    assert.equal(out.status, 'paused');
    assert.deepEqual(out.paused_on, {
      action_id: '33333333-3333-3333-3333-333333333333',
      tool_use_id: 'tu_xyz',
      dejavas_tool: 'gmail.send',
    });
  });
});
