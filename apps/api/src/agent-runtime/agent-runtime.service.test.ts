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
import { AI_CRM_HYGIENE_JOB } from './jobs/ai-crm-hygiene.js';
import { AI_REPLY_HANDLER_JOB } from './jobs/ai-reply-handler.js';
import { AI_SDR_FOLLOWUP_JOB } from './jobs/ai-sdr-followup.js';
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

describe('AgentRuntimeService.resumeRun', () => {
  it('continues the loop with the resolved tool_result appended', async () => {
    // First half of the run: tool_use → awaiting_approval → pause.
    const { service, llm: pauseLlm } = makeService(
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
    const paused = await service.runJob({
      jobKey: 'test-tiny',
      orgId: 'org_1',
      agentId: 'agent_1',
      context: {},
    });
    assert.equal(paused.status, 'paused');
    assert.equal(pauseLlm.requests.length, 1);

    // Resume: build a new service with another canned LLM response that
    // wraps up the run, plus reuse the saved state from the pause.
    const fakeLlm = new FakeLlmClient([
      llm([{ type: 'text', text: 'Approved, moving on.' }]),
    ]);
    const fakeActions = makeFakeActions([]);
    const resumeService = new AgentRuntimeService(
      fakeActions.service as ActionsService,
      registryWith(tinyJob),
      fakeLlm,
    );
    const resumed = await resumeService.resumeRun({
      jobKey: 'test-tiny',
      orgId: 'org_1',
      agentId: 'agent_1',
      savedMessages: paused.messages,
      savedTranscript: paused.transcript,
      savedUsage: paused.usage ?? {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      resolvedAction: {
        tool_use_id: paused.paused_on!.tool_use_id,
        action_id: paused.paused_on!.action_id,
        status: 'executed',
        policy_decision: decision('require_approval'),
        result: { ok: true, sent: true },
      },
    });

    assert.equal(resumed.status, 'completed');
    // Transcript should now end with the agent's final message.
    const last = resumed.transcript.at(-1);
    assert.equal(last?.type, 'agent_message');
    // The resolved tool_result should have replaced the awaiting_approval
    // entry on the transcript.
    const toolResult = resumed.transcript.find(
      (t) => t.type === 'tool_result' && t.action_id === 'act_pending',
    );
    assert.ok(toolResult);
    if (toolResult?.type === 'tool_result') {
      assert.equal(toolResult.status, 'executed');
    }
    // Resume LLM call should have seen a tool_result block as the last
    // user message.
    assert.equal(fakeLlm.requests.length, 1);
    const lastMsg = fakeLlm.requests[0]?.messages.at(-1);
    assert.equal(lastMsg?.role, 'user');
    assert.ok(
      lastMsg?.content.some(
        (b) => b.type === 'tool_result' && b.tool_use_id === paused.paused_on!.tool_use_id,
      ),
    );
    // Usage should be additive across both calls.
    assert.equal(resumed.usage?.input_tokens, 200);
    assert.equal(resumed.usage?.output_tokens, 80);
  });

  it('feeds is_error: true when the action was denied', async () => {
    const { service } = makeService(
      registryWith(tinyJob),
      [
        llm([
          { type: 'tool_use', id: 'tu_pause', name: 'do_thing', input: { value: 'x' } },
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
    const paused = await service.runJob({
      jobKey: 'test-tiny',
      orgId: 'org_1',
      agentId: 'agent_1',
      context: {},
    });

    const fakeLlm = new FakeLlmClient([
      llm([{ type: 'text', text: 'Acknowledged denial.' }]),
    ]);
    const resumeService = new AgentRuntimeService(
      makeFakeActions([]).service as ActionsService,
      registryWith(tinyJob),
      fakeLlm,
    );
    await resumeService.resumeRun({
      jobKey: 'test-tiny',
      orgId: 'org_1',
      agentId: 'agent_1',
      savedMessages: paused.messages,
      savedTranscript: paused.transcript,
      savedUsage: paused.usage ?? {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      resolvedAction: {
        tool_use_id: paused.paused_on!.tool_use_id,
        action_id: paused.paused_on!.action_id,
        status: 'denied',
        policy_decision: decision('require_approval'),
      },
    });

    const lastUserMsg = fakeLlm.requests[0]?.messages.at(-1);
    assert.equal(lastUserMsg?.role, 'user');
    const block = lastUserMsg?.content[0];
    if (block?.type === 'tool_result') {
      assert.equal(block.is_error, true);
    } else {
      assert.fail('expected tool_result block');
    }
  });
});

describe('AI CRM hygiene job — config sanity', () => {
  it('registers without conflict and declares the expected Dejavas tools', () => {
    const r = new JobRegistry();
    r.register(AI_CRM_HYGIENE_JOB);
    assert.deepEqual(r.keys(), ['ai-crm-hygiene']);
    const tools = AI_CRM_HYGIENE_JOB.tools.map((t) => t.dejavasTool).sort();
    assert.deepEqual(tools, [
      'apollo.people.match',
      'hubspot.contacts.search',
      'hubspot.contacts.update',
    ]);
  });

  it('initial message lists every input contact and the operator notes', () => {
    const msg = AI_CRM_HYGIENE_JOB.buildInitialMessage({
      contact_emails: ['ada@acme.com', 'bob@globex.io', 'carol@initech.com'],
      notes: 'pre-Q3 cleanup',
    });
    assert.ok(msg.includes('ada@acme.com'));
    assert.ok(msg.includes('bob@globex.io'));
    assert.ok(msg.includes('carol@initech.com'));
    assert.ok(msg.includes('pre-Q3 cleanup'));
  });

  it('handles an empty contact list gracefully without crashing', () => {
    const msg = AI_CRM_HYGIENE_JOB.buildInitialMessage({});
    assert.ok(msg.includes('no contacts provided'));
  });

  it('find_hubspot_contact paramMapper wraps email in a HubSpot search filter', () => {
    const find = AI_CRM_HYGIENE_JOB.tools.find(
      (t) => t.name === 'find_hubspot_contact',
    );
    assert.ok(find?.paramMapper);
    const mapped = find!.paramMapper!({ email: 'ada@acme.com' });
    assert.deepEqual(mapped, {
      filters: [{ propertyName: 'email', operator: 'EQ', value: 'ada@acme.com' }],
      limit: 1,
    });
  });

  it('fill_missing_contact_fields paramMapper omits empty values', () => {
    const fill = AI_CRM_HYGIENE_JOB.tools.find(
      (t) => t.name === 'fill_missing_contact_fields',
    );
    assert.ok(fill?.paramMapper);
    const mapped = fill!.paramMapper!({
      email: 'ada@acme.com',
      firstname: 'Ada',
      lastname: '',
      company: 'Acme',
      jobtitle: undefined as unknown as string,
    });
    assert.equal(mapped.email, 'ada@acme.com');
    const props = mapped.properties as Record<string, unknown>;
    assert.equal(props.firstname, 'Ada');
    assert.equal(props.company, 'Acme');
    assert.equal('lastname' in props, false, 'empty strings should be dropped');
    assert.equal('jobtitle' in props, false, 'undefined should be dropped');
  });
});

describe('Bundle expansion sanity — runtime hosts both jobs', () => {
  it('JobRegistry holds AI SDR + AI CRM hygiene side-by-side', () => {
    const r = new JobRegistry();
    r.register(AI_SDR_OUTBOUND_JOB);
    r.register(AI_CRM_HYGIENE_JOB);
    assert.deepEqual(r.keys().sort(), ['ai-crm-hygiene', 'ai-sdr-outbound']);
  });

  it('both jobs share the same model + structural shape (same runtime path)', () => {
    for (const job of [AI_SDR_OUTBOUND_JOB, AI_CRM_HYGIENE_JOB]) {
      assert.equal(job.model, 'claude-opus-4-7');
      assert.ok(job.systemPrompt.length > 0);
      assert.ok(job.tools.length > 0);
      assert.equal(typeof job.buildInitialMessage, 'function');
    }
  });
});

describe('AgentRuntimeService — AI CRM hygiene end-to-end loop', () => {
  it('walks a single contact through find → enrich → update → done', async () => {
    const { service, actionsCalls } = makeService(
      registryWith(AI_CRM_HYGIENE_JOB),
      [
        llm([
          {
            type: 'tool_use',
            id: 'tu_find',
            name: 'find_hubspot_contact',
            input: { email: 'ada@acme.com' },
          },
        ]),
        llm([
          {
            type: 'tool_use',
            id: 'tu_enrich',
            name: 'enrich_person',
            input: { email: 'ada@acme.com' },
          },
        ]),
        llm([
          {
            type: 'tool_use',
            id: 'tu_fill',
            name: 'fill_missing_contact_fields',
            input: { email: 'ada@acme.com', firstname: 'Ada', company: 'Acme' },
          },
        ]),
        llm([
          {
            type: 'text',
            text: 'Processed 1 contact, filled 2 fields. Done.',
          },
        ]),
      ],
      [
        {
          action_id: 'act_find',
          status: 'executed',
          result: { ok: true, items: [{ id: 'contact_123' }] },
          policy_decision: decision('allow'),
        },
        {
          action_id: 'act_enrich',
          status: 'executed',
          result: { ok: true, person: { first_name: 'Ada', company: 'Acme' } },
          policy_decision: decision('allow'),
        },
        {
          action_id: 'act_fill',
          status: 'executed',
          result: { ok: true, updated: true },
          policy_decision: decision('allow'),
        },
      ],
    );

    const result = await service.runJob({
      jobKey: 'ai-crm-hygiene',
      orgId: 'org_1',
      agentId: 'agent_1',
      context: { contact_emails: ['ada@acme.com'] },
    });

    assert.equal(result.status, 'completed');
    assert.equal(actionsCalls.length, 3);
    assert.deepEqual(
      actionsCalls.map((c) => c.input.tool),
      [
        'hubspot.contacts.search',
        'apollo.people.match',
        'hubspot.contacts.update',
      ],
    );
    // The fill call should have been mapped to {email, properties}.
    const fillCall = actionsCalls[2]!.input;
    assert.equal(fillCall.params['email'], 'ada@acme.com');
    const props = fillCall.params['properties'] as Record<string, unknown>;
    assert.equal(props.firstname, 'Ada');
    assert.equal(props.company, 'Acme');

    const finalMsg = result.transcript.find((t) => t.type === 'agent_message');
    assert.ok(finalMsg);
  });
});

describe('AI reply-handler job — config sanity', () => {
  it('registers without conflict and declares the expected Dejavas tools', () => {
    const r = new JobRegistry();
    r.register(AI_REPLY_HANDLER_JOB);
    assert.deepEqual(r.keys(), ['ai-reply-handler']);
    const tools = AI_REPLY_HANDLER_JOB.tools.map((t) => t.dejavasTool).sort();
    assert.deepEqual(tools, [
      'gmail.messages.get',
      'gmail.send',
      'gmail.threads.get',
    ]);
  });

  it('initial message includes the thread id and recipient context', () => {
    const msg = AI_REPLY_HANDLER_JOB.buildInitialMessage({
      thread_id: 'thr_abc123',
      reply_message_id: 'msg_def456',
      to_email: 'lead@acme.com',
      subject: 'Re: AI SDR you can run in prod',
      source_run_id: '11111111-1111-1111-1111-111111111111',
    });
    assert.ok(msg.includes('thr_abc123'));
    assert.ok(msg.includes('msg_def456'));
    assert.ok(msg.includes('lead@acme.com'));
    assert.ok(msg.includes('Re: AI SDR'));
    assert.ok(msg.includes('source_run_id'));
  });

  it('handles missing context fields gracefully', () => {
    const msg = AI_REPLY_HANDLER_JOB.buildInitialMessage({});
    assert.ok(msg.includes('(missing)'));
  });

  it('read_thread_metadata paramMapper wraps the thread id', () => {
    const tool = AI_REPLY_HANDLER_JOB.tools.find(
      (t) => t.name === 'read_thread_metadata',
    );
    assert.ok(tool?.paramMapper);
    const mapped = tool!.paramMapper!({ thread_id: 'thr_abc' });
    assert.deepEqual(mapped, { threadId: 'thr_abc', format: 'metadata' });
  });

  it('send_reply paramMapper passes threadId so Gmail keeps the thread together', () => {
    const tool = AI_REPLY_HANDLER_JOB.tools.find(
      (t) => t.name === 'send_reply',
    );
    assert.ok(tool?.paramMapper);
    const mapped = tool!.paramMapper!({
      to: 'lead@acme.com',
      subject: 'Re: AI SDR',
      body: 'Happy to chat',
      thread_id: 'thr_abc',
    });
    assert.equal(mapped.to, 'lead@acme.com');
    assert.equal(mapped.threadId, 'thr_abc');
    assert.equal(mapped.body, 'Happy to chat');
  });
});

describe('Bundle expansion sanity — runtime hosts all four jobs', () => {
  it('JobRegistry holds SDR + hygiene + reply-handler + sdr-followup side-by-side', () => {
    const r = new JobRegistry();
    r.register(AI_SDR_OUTBOUND_JOB);
    r.register(AI_CRM_HYGIENE_JOB);
    r.register(AI_REPLY_HANDLER_JOB);
    r.register(AI_SDR_FOLLOWUP_JOB);
    assert.deepEqual(r.keys().sort(), [
      'ai-crm-hygiene',
      'ai-reply-handler',
      'ai-sdr-followup',
      'ai-sdr-outbound',
    ]);
  });
});

describe('AI SDR follow-up job — config sanity', () => {
  it('registers without conflict and declares the expected Dejavas tools', () => {
    const r = new JobRegistry();
    r.register(AI_SDR_FOLLOWUP_JOB);
    assert.deepEqual(r.keys(), ['ai-sdr-followup']);
    const tools = AI_SDR_FOLLOWUP_JOB.tools.map((t) => t.dejavasTool).sort();
    assert.deepEqual(tools, [
      'gmail.messages.get',
      'gmail.send',
      'gmail.threads.get',
    ]);
  });

  it('initial message includes the touch number, thread id, and recipient', () => {
    const msg = AI_SDR_FOLLOWUP_JOB.buildInitialMessage({
      thread_id: 'thr_seq_123',
      to_email: 'cto@globex.com',
      subject: 'AI SDR you can run in prod',
      touch_number: 2,
      original_run_id: '99999999-9999-9999-9999-999999999999',
    });
    assert.ok(msg.includes('touch 2'));
    assert.ok(msg.includes('thr_seq_123'));
    assert.ok(msg.includes('cto@globex.com'));
    assert.ok(msg.includes('AI SDR you can run in prod'));
    assert.ok(msg.includes('original_run_id'));
  });

  it('initial message handles missing fields gracefully', () => {
    const msg = AI_SDR_FOLLOWUP_JOB.buildInitialMessage({});
    assert.ok(msg.includes('(missing)'));
    assert.ok(msg.includes('(unknown)'));
  });

  it('read_thread_metadata paramMapper wraps the thread id with format=metadata', () => {
    const tool = AI_SDR_FOLLOWUP_JOB.tools.find(
      (t) => t.name === 'read_thread_metadata',
    );
    assert.ok(tool?.paramMapper);
    const mapped = tool!.paramMapper!({ thread_id: 'thr_abc' });
    assert.deepEqual(mapped, { threadId: 'thr_abc', format: 'metadata' });
  });

  it('send_followup paramMapper threads correctly via gmail.send + threadId', () => {
    const tool = AI_SDR_FOLLOWUP_JOB.tools.find(
      (t) => t.name === 'send_followup',
    );
    assert.ok(tool?.paramMapper);
    const mapped = tool!.paramMapper!({
      to: 'cto@globex.com',
      subject: 'AI SDR you can run in prod',
      body: 'still relevant?',
      thread_id: 'thr_seq_123',
    });
    assert.equal(mapped.to, 'cto@globex.com');
    assert.equal(mapped.subject, 'AI SDR you can run in prod');
    assert.equal(mapped.body, 'still relevant?');
    assert.equal(mapped.threadId, 'thr_seq_123');
  });
});
