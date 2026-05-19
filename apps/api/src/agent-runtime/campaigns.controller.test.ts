import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { BadRequestException } from '@nestjs/common';
import { CampaignsController } from './campaigns.controller.js';
import { JobRegistry } from './job.js';
import { AI_SDR_OUTBOUND_JOB } from './jobs/ai-sdr-outbound.js';
import type { AgentRuntimeService } from './agent-runtime.service.js';
import type { AgentsService } from '../agents/agents.service.js';
import type { AgentRunResult } from './transcript.js';

function makeController(opts: {
  registry?: JobRegistry;
  runtimeResult?: AgentRunResult;
  orgId?: string;
}): {
  controller: CampaignsController;
  runtimeCalls: Array<Parameters<AgentRuntimeService['runJob']>[0]>;
} {
  const registry = opts.registry ?? makeRegistry();
  const runtimeCalls: Array<Parameters<AgentRuntimeService['runJob']>[0]> = [];
  const runtime: Pick<AgentRuntimeService, 'runJob'> = {
    async runJob(input) {
      runtimeCalls.push(input);
      return (
        opts.runtimeResult ?? {
          status: 'completed',
          transcript: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      );
    },
  };
  const agents: Pick<AgentsService, 'ensureDefaultOrg'> = {
    async ensureDefaultOrg() {
      return opts.orgId ?? '00000000-0000-0000-0000-0000000000aa';
    },
  };
  return {
    controller: new CampaignsController(
      runtime as AgentRuntimeService,
      registry,
      agents as AgentsService,
    ),
    runtimeCalls,
  };
}

function makeRegistry(): JobRegistry {
  const r = new JobRegistry();
  r.register(AI_SDR_OUTBOUND_JOB);
  return r;
}

describe('CampaignsController.jobs', () => {
  it('lists every registered job with label + description + tools', () => {
    const { controller } = makeController({});
    const out = controller.jobs();
    assert.equal(out.items.length, 1);
    const job = out.items[0]!;
    assert.equal(job.key, 'ai-sdr-outbound');
    assert.equal(job.model, 'claude-opus-4-7');
    assert.ok(job.tools.some((t) => t.dejavas_tool === 'gmail.send'));
  });

  it('reflects newly registered jobs without restart', () => {
    const r = makeRegistry();
    r.register({
      key: 'crm-hygiene-stub',
      label: 'Stub hygiene job',
      description: 'placeholder',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'stub',
      buildInitialMessage: () => 'stub',
      tools: [],
    });
    const { controller } = makeController({ registry: r });
    assert.deepEqual(
      controller.jobs().items.map((j) => j.key).sort(),
      ['ai-sdr-outbound', 'crm-hygiene-stub'],
    );
  });
});

describe('CampaignsController.run', () => {
  it('forwards the validated request to the runtime with the resolved orgId', async () => {
    const { controller, runtimeCalls } = makeController({});
    await controller.run({
      job_key: 'ai-sdr-outbound',
      agent_id: '11111111-1111-1111-1111-111111111111',
      context: { email: 'lead@acme.com' },
    });
    assert.equal(runtimeCalls.length, 1);
    const call = runtimeCalls[0]!;
    assert.equal(call.jobKey, 'ai-sdr-outbound');
    assert.equal(call.agentId, '11111111-1111-1111-1111-111111111111');
    assert.deepEqual(call.context, { email: 'lead@acme.com' });
    // The orgId comes from agents.ensureDefaultOrg, not the request body —
    // RevOps doesn't get to spoof another org via the runtime.
    assert.equal(call.orgId, '00000000-0000-0000-0000-0000000000aa');
  });

  it('rejects unknown job keys with BadRequest before touching the runtime', async () => {
    const { controller, runtimeCalls } = makeController({});
    await assert.rejects(
      () =>
        controller.run({
          job_key: 'does-not-exist',
          agent_id: '11111111-1111-1111-1111-111111111111',
          context: {},
        }),
      BadRequestException,
    );
    assert.equal(runtimeCalls.length, 0);
  });

  it('passes the runtime result through unchanged', async () => {
    const paused: AgentRunResult = {
      status: 'paused',
      transcript: [],
      paused_on: {
        action_id: 'act_1',
        tool_use_id: 'tu_1',
        dejavas_tool: 'gmail.send',
      },
      usage: { input_tokens: 100, output_tokens: 40 },
    };
    const { controller } = makeController({ runtimeResult: paused });
    const out = await controller.run({
      job_key: 'ai-sdr-outbound',
      agent_id: '22222222-2222-2222-2222-222222222222',
      context: { email: 'a@b.com' },
    });
    assert.equal(out.status, 'paused');
    assert.equal(out.paused_on?.dejavas_tool, 'gmail.send');
  });
});
