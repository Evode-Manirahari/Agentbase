// Job config — a Job is a recipe the runtime can run. It declares the LLM
// system prompt, the tools the agent is allowed to reach for, and the
// initial user message template.
//
// "Revenue Agent — outbound" is the first bundled job. Adding CRM hygiene,
// deal-update, or other revenue workflows means writing another Job constant — no runtime
// changes. The runtime is generic; the agent's behavior lives in the job
// definition.

// The model IDs we know about. We default to claude-opus-4-7 (per CLAUDE.md
// memory + the claude-api skill). The Anthropic SDK accepts any string, but
// keeping this typed catches typos at compile time.
export type AgentRuntimeModel =
  | 'claude-opus-4-7'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5-20251001';

// One tool the agent can call. The job declares the user-facing name and
// JSON schema (the LLM sees these), plus the Agentbase tool name and an
// optional param mapper to translate LLM-supplied input into the shape
// Agentbase expects.
export interface JobTool {
  name: string;
  description: string;
  // Plain JSON Schema, fed straight to the LLM. Keep this conservative —
  // flat objects of primitives map best onto LLM tool-use semantics.
  inputSchema: Record<string, unknown>;
  // The Agentbase tool name to invoke (e.g. 'gmail.send', 'hubspot.deals.update').
  // The policy engine, approval routing, audit log, and connector dispatch
  // all key off this. Must match the tool names in the policy DSL.
  agentbaseTool: string;
  // Optional translation from LLM-supplied input to Agentbase params. If
  // omitted the input is passed through verbatim.
  paramMapper?: (input: Record<string, unknown>) => Record<string, unknown>;
}

export interface Job {
  key: string;
  label: string;
  description: string;
  model: AgentRuntimeModel;
  // Stable system prompt — kept frozen so prompt caching works. Per-run
  // context goes in the user message, not here.
  systemPrompt: string;
  tools: JobTool[];
  // Upper bound on loop iterations. The runtime stops if Claude is still
  // calling tools after this many rounds. Protects against pathological
  // loops.
  maxIterations?: number;
  // Builds the initial user message from the job's input context. Lets each
  // job define its own input schema while the runtime stays generic.
  buildInitialMessage: (context: Record<string, unknown>) => string;
}

// A small in-memory registry. Jobs are static config; a real registry will
// land alongside the dashboard surface (PR 3). For now a Map keyed by job
// `key` is enough — the runtime takes a job key, looks it up, runs it.
export class JobRegistry {
  private readonly jobs = new Map<string, Job>();

  register(job: Job): void {
    if (this.jobs.has(job.key)) {
      throw new Error(`Job already registered: ${job.key}`);
    }
    this.jobs.set(job.key, job);
  }

  get(key: string): Job {
    const job = this.jobs.get(key);
    if (!job) {
      throw new Error(`Unknown job: ${key}`);
    }
    return job;
  }

  keys(): string[] {
    return [...this.jobs.keys()];
  }
}
