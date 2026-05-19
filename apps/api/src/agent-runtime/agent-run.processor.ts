import { Injectable, Logger } from '@nestjs/common';
import { AgentRunsService } from './agent-runs.service.js';
import { AgentRuntimeService } from './agent-runtime.service.js';
import type { AgentRunJobData } from '../queue/queue.tokens.js';

// Worker-side processor. Owns the lifecycle of one agent_runs row:
//   start mode:  pending → running → (paused | completed | failed)
//   resume mode: paused  → running → (paused | completed | failed)
//
// Anything that throws here ends up in the BullMQ failed-jobs queue and
// the row stays in whatever status it was — operators can retry from
// the dashboard once the underlying issue is fixed.
@Injectable()
export class AgentRunProcessor {
  private readonly log = new Logger(AgentRunProcessor.name);

  constructor(
    private readonly runs: AgentRunsService,
    private readonly runtime: AgentRuntimeService,
  ) {}

  async process(data: AgentRunJobData): Promise<{ status: string }> {
    const run = await this.runs.markRunning(data.run_id);
    if (!run) {
      this.log.warn(`agent run ${data.run_id} not found, skipping`);
      return { status: 'not_found' };
    }

    try {
      if (data.mode === 'start') {
        const result = await this.runtime.runJob({
          jobKey: run.job_key,
          orgId: run.org_id,
          agentId: run.agent_id,
          context: run.context,
        });
        await this.runs.persistResult(data.run_id, result);
        return { status: result.status };
      }

      // resume mode
      if (!run.paused_on_action_id || !run.paused_on_tool_use_id) {
        await this.runs.persistResult(data.run_id, {
          status: 'failed',
          transcript: run.transcript,
          messages: run.messages,
          error: 'resume requested but run has no paused_on info',
          ...(run.usage ? { usage: run.usage } : {}),
        });
        return { status: 'failed' };
      }
      const resolved = await this.runs.resolveAction(
        run.org_id,
        run.paused_on_action_id,
        run.paused_on_tool_use_id,
      );
      if (!resolved) {
        this.log.warn(
          `resume for run ${data.run_id}: action ${run.paused_on_action_id} not yet resolved`,
        );
        return { status: 'still_pending' };
      }
      const result = await this.runtime.resumeRun({
        jobKey: run.job_key,
        orgId: run.org_id,
        agentId: run.agent_id,
        savedMessages: run.messages,
        savedTranscript: run.transcript,
        savedUsage: run.usage ?? {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        resolvedAction: resolved,
      });
      await this.runs.persistResult(data.run_id, result);
      return { status: result.status };
    } catch (err) {
      const message = (err as Error).message ?? 'unknown error';
      this.log.error(`run ${data.run_id} failed: ${message}`);
      await this.runs.persistResult(data.run_id, {
        status: 'failed',
        transcript: run.transcript,
        messages: run.messages,
        error: message,
        ...(run.usage ? { usage: run.usage } : {}),
      });
      throw err;
    }
  }
}
