import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { PolicyDecision } from '@dejavas/shared';
import { AgentRuntimeService } from './agent-runtime.service.js';
import { JobRegistry, type Job } from './job.js';
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmClient,
  LlmContentBlock,
} from './llm-client.js';
import { AI_SDR_OUTBOUND_JOB } from './jobs/ai-sdr-outbound.js';
import type { ActionsService } from '../actions/actions.service.js';
import type { ExecuteInput, ExecuteOutput } from '../actions/actions.service.js';

class FakeLlmClient implements LlmClient {
  public requests: LlmChatRequest[] = [];
  constructor(private readonly responses: LlmChatResponse[]) {}
  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    // Snapshot the request — the runtime keeps mutating `messages` after
    // this returns, and we want to assert on what was sent.
    this.requests.push({
      ...req,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: [...m.content],
      })),
    });
    const next = this.responses.shift();
    if (!next) {
      throw new Error('FakeLlmClient ran out of canned responses');
    }
    return next;
  }
}

interface FakeActionsCall {
  input: ExecuteInput;
}

function makeFakeActions(
  outputs: ExecuteOutput[],
): { service: Pick<ActionsService, 'execute'>; calls: FakeActionsCall[] } {
  const calls: FakeActionsCall[] = [];
  const service: Pick<ActionsService, 'execute'> = {
    async execute(input) {
      calls.push({ input });
      const next = outputs.shift();
      if (!next) throw new Error('fake actions ran out of outputs');
      return next;
    },
  };
  return { service, calls };
}

function decision(effect: PolicyDecision['effect'] = 'allow'): PolicyDecision {
  return {
    effect,
    reason: null,
    rule_index: null,
    rule_matched: null,
    approver_role: null,
    policy_id: null,
    fallback: false,
  };
}

function llm(
  content: LlmContentBlock[],
  stop_reason: LlmChatResponse['stop_reason'] = 'end_turn',
): LlmChatResponse {
  return {
    content,
    stop_reason,
    usage: { input_tokens: 100, output_tokens: 40 },
  };
}

function registryWith(job: Job): JobRegistry {
  const r = new JobRegistry();
  r.register(job);
  return r;
}

function makeService(
  registry: JobRegistry,
  llmResponses: LlmChatResponse[],
  actionOutputs: ExecuteOutput[],
): { service: AgentRuntimeService; llm: FakeLlmClient; actionsCalls: FakeActionsCall[] } {
  const fakeLlm = new FakeLlmClient(llmResponses);
  const fakeActions = makeFakeActions(actionOutputs);
  const service = new AgentRuntimeService(
    fakeActions.service as ActionsService,
    registry,
    fakeLlm,
  );
  return { service, llm: fakeLlm, actionsCalls: fakeActions.calls };
}

const tinyJob: Job = {
  key: 'test-tiny',
  label: 'tiny',
  description: 'minimal test job',
  model: 'claude-opus-4-7',
  systemPrompt: 'You are a test agent.',
  buildInitialMessage: (ctx) =>
    `process: ${JSON.stringify(ctx)}`,
  tools: [
    {
      name: 'do_thing',
      description: 'Do a thing',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      dejavasTool: 'test.do_thing',
    },
  ],
};

describe('AgentRuntimeService — happy path', () => {
  it('completes the run when Claude tool-uses then ends turn', async () => {
    const { service, llm: llmClient, actionsCalls } = makeService(
      registryWith(tinyJob),
      [
        llm([
          { type: 'text', text: 'Calling do_thing.' },
          { type: 'tool_use', id: 'tu_1', name: 'do_thing', input: { value: 'x' } },
        ]),
        llm([{ type: 'text', text: 'Done.' }]),
      ],
      [
        {
          action_id: 'act_1',
          status: 'executed',
          result: { ok: true, foo: 'bar' },
          policy_decision: decision('allow'),
        },
      ],
    );

    const result = await service.runJob({
      jobKey: 'test-tiny',
      orgId: 'org_1',
      agentId: 'agent_1',
      context: { lead: 'a@b.com' },
    });

    assert.equal(result.status, 'completed');
    assert.equal(actionsCalls.length, 1);
    assert.equal(actionsCalls[0]?.input.tool, 'test.do_thing');
    assert.deepEqual(actionsCalls[0]?.input.params, { value: 'x' });

    const callEntry = result.transcript.find((t) => t.type === 'tool_call');
    const resultEntry = result.transcript.find((t) => t.type === 'tool_result');
    assert.ok(callEntry);
    assert.ok(resultEntry);
    if (resultEntry?.type === 'tool_result') {
      assert.equal(resultEntry.status, 'executed');
      assert.equal(resultEntry.action_id, 'act_1');
    }

    assert.equal(result.usage?.input_tokens, 200);
    assert.equal(result.usage?.output_tokens, 80);

    // Sanity: the second LLM turn carried a tool_result feed-back.
    assert.equal(llmClient.requests.length, 2);
    const secondTurn = llmClient.requests[1];
    const lastMsg = secondTurn?.messages.at(-1);
    assert.equal(lastMsg?.role, 'user');
    assert.ok(
      lastMsg?.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'tu_1'),
    );
  });
});

describe('AgentRuntimeService — awaiting_approval', () => {
  it('pauses the run and returns the resume signal', async () => {
    const { service, llm: llmClient } = makeService(
      registryWith(tinyJob),
      [
        llm([
          { type: 'tool_use', id: 'tu_pause', name: 'do_thing', input: { value: 'risky' } },
        ]),
      ],
      [
        {
          action_id: 'act_pending',
          status: 'awaiting_approval',
          policy_decision: decision('require_approval'),
        },
      ],
    );

    const result = await service.runJob({
      jobKey: 'test-tiny',
      orgId: 'org_1',
      agentId: 'agent_1',
      context: {},
    });

    assert.equal(result.status, 'paused');
    assert.equal(result.paused_on?.action_id, 'act_pending');
    assert.equal(result.paused_on?.tool_use_id, 'tu_pause');
    assert.equal(result.paused_on?.dejavas_tool, 'test.do_thing');

    // Critical: we should NOT have made a second LLM call. The run halts.
    assert.equal(llmClient.requests.length, 1);
  });
});

describe('AgentRuntimeService — denied tool continues the loop', () => {
  it('feeds the denial back to Claude as a tool_result and lets it finish', async () => {
    const { service } = makeService(
      registryWith(tinyJob),
      [
        llm([
          { type: 'tool_use', id: 'tu_denied', name: 'do_thing', input: { value: 'forbidden' } },
        ]),
        llm([{ type: 'text', text: 'Acknowledged — moving on.' }]),
      ],
      [
        {
          action_id: 'act_denied',
          status: 'denied',
          policy_decision: decision('deny'),
        },
      ],
    );

    const result = await service.runJob({
      jobKey: 'test-tiny',
      orgId: 'org_1',
      agentId: 'agent_1',
      context: {},
    });

    assert.equal(result.status, 'completed');
    const resultEntry = result.transcript.find((t) => t.type === 'tool_result');
    assert.ok(resultEntry);
    if (resultEntry?.type === 'tool_result') {
      assert.equal(resultEntry.status, 'denied');
    }
  });
});

describe('AgentRuntimeService — unknown tool', () => {
  it('feeds an error back to Claude rather than calling Dejavas', async () => {
    const { service, actionsCalls } = makeService(
      registryWith(tinyJob),
      [
        llm([
          {
            type: 'tool_use',
            id: 'tu_bad',
            name: 'does_not_exist',
            input: {},
          },
        ]),
        llm([{ type: 'text', text: 'Sorry, I will not retry.' }]),
      ],
      [],
    );

    const result = await service.runJob({
      jobKey: 'test-tiny',
      orgId: 'org_1',
      agentId: 'agent_1',
      context: {},
    });

    assert.equal(result.status, 'completed');
    assert.equal(actionsCalls.length, 0, 'unknown tool should not hit Dejavas');
  });
});

describe('AgentRuntimeService — max iterations cap', () => {
  it('halts with failed status after maxIterations consecutive tool-use turns', async () => {
    const loopingJob: Job = { ...tinyJob, key: 'looping', maxIterations: 3 };
    const llmResponses: LlmChatResponse[] = Array.from({ length: 5 }, (_, i) =>
      llm(
        [
          {
            type: 'tool_use',
            id: `tu_${i}`,
            name: 'do_thing',
            input: { value: String(i) },
          },
        ],
        'tool_use',
      ),
    );
    const actionOutputs: ExecuteOutput[] = Array.from({ length: 5 }, (_, i) => ({
      action_id: `act_${i}`,
      status: 'executed' as const,
      result: { i },
      policy_decision: decision('allow'),
    }));

    const { service } = makeService(
      registryWith(loopingJob),
      llmResponses,
      actionOutputs,
    );

    const result = await service.runJob({
      jobKey: 'looping',
      orgId: 'org_1',
      agentId: 'agent_1',
      context: {},
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /did not finish within 3 iterations/);
  });
});

describe('AgentRuntimeService — unknown job', () => {
  it('throws a clear error', async () => {
    const { service } = makeService(registryWith(tinyJob), [], []);
    await assert.rejects(
      () =>
        service.runJob({
          jobKey: 'nope',
          orgId: 'org_1',
          agentId: 'agent_1',
          context: {},
        }),
      /Unknown job: nope/,
    );
  });
});

describe('AI SDR job — config sanity', () => {
  it('registers without conflict', () => {
    const r = new JobRegistry();
    r.register(AI_SDR_OUTBOUND_JOB);
    assert.deepEqual(r.keys(), ['ai-sdr-outbound']);
  });

  it('declares the expected Dejavas tool surface', () => {
    const tools = AI_SDR_OUTBOUND_JOB.tools.map((t) => t.dejavasTool).sort();
    assert.deepEqual(tools, [
      'apollo.organizations.match',
      'apollo.people.match',
      'gmail.draft.create',
      'gmail.send',
      'hubspot.contacts.upsert',
    ]);
  });

  it('upsert paramMapper produces the shape the HubSpot connector expects', () => {
    const upsert = AI_SDR_OUTBOUND_JOB.tools.find(
      (t) => t.name === 'upsert_hubspot_contact',
    );
    assert.ok(upsert?.paramMapper);
    const mapped = upsert!.paramMapper!({
      email: 'a@b.com',
      firstname: 'Ada',
      company: 'Acme',
      lastname: '',
    });
    assert.equal(mapped.email, 'a@b.com');
    const props = mapped.properties as Record<string, unknown>;
    assert.equal(props.email, 'a@b.com');
    assert.equal(props.firstname, 'Ada');
    assert.equal(props.company, 'Acme');
    assert.equal(props.lifecyclestage, 'salesqualifiedlead');
    assert.equal('lastname' in props, false, 'empty strings should be dropped');
  });

  it('initial message includes lead email', () => {
    const msg = AI_SDR_OUTBOUND_JOB.buildInitialMessage({
      email: 'lead@acme.com',
      notes: 'demo request',
    });
    assert.ok(msg.includes('lead@acme.com'));
    assert.ok(msg.includes('demo request'));
  });
});
