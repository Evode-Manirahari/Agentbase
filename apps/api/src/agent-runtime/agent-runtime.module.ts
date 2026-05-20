import { Global, Module, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActionsModule } from '../actions/actions.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { ConnectorsModule } from '../connectors/connectors.module.js';
import { AgentRunProcessor } from './agent-run.processor.js';
import { AgentRunsService } from './agent-runs.service.js';
import { AgentRuntimeService } from './agent-runtime.service.js';
import { CampaignsController } from './campaigns.controller.js';
import { EmailsService } from './emails.service.js';
import { JobRegistry } from './job.js';
import { AI_CRM_HYGIENE_JOB } from './jobs/ai-crm-hygiene.js';
import { AI_REPLY_HANDLER_JOB } from './jobs/ai-reply-handler.js';
import { AI_SDR_FOLLOWUP_JOB } from './jobs/ai-sdr-followup.js';
import { AI_SDR_OUTBOUND_JOB } from './jobs/ai-sdr-outbound.js';
import { AnthropicLlmClient, LLM_CLIENT, type LlmClient } from './llm-client.js';

// Loud-fail stub used when ANTHROPIC_API_KEY isn't configured. Lets the
// API boot in environments that don't need the runtime (CI without the
// key, local dev not running agents) while making any actual agent run
// fail with a clear, actionable error.
class UnconfiguredLlmClient implements LlmClient {
  async chat(): Promise<never> {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. The agent runtime cannot make LLM calls. ' +
        'Set ANTHROPIC_API_KEY on the API process to run AI SDR campaigns.',
    );
  }
}

// @Global so QueueModule's worker can @Optional-inject AgentRunProcessor
// and EmailsService at boot. Without this, the worker silently drops
// `agent.run` and `emails.poll_replies` jobs with "service not wired"
// even though the providers are registered — Nest only resolves
// cross-module DI through explicit imports or Global.
@Global()
@Module({
  imports: [ActionsModule, ConnectorsModule, forwardRef(() => AgentsModule)],
  controllers: [CampaignsController],
  providers: [
    AgentRuntimeService,
    AgentRunsService,
    AgentRunProcessor,
    EmailsService,
    {
      provide: JobRegistry,
      useFactory: () => {
        const registry = new JobRegistry();
        registry.register(AI_SDR_OUTBOUND_JOB);
        registry.register(AI_CRM_HYGIENE_JOB);
        registry.register(AI_REPLY_HANDLER_JOB);
        registry.register(AI_SDR_FOLLOWUP_JOB);
        return registry;
      },
    },
    {
      provide: LLM_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): LlmClient => {
        const log = new Logger('AgentRuntimeModule');
        const apiKey = config.get<string>('ANTHROPIC_API_KEY');
        if (!apiKey || apiKey.trim().length === 0) {
          log.warn(
            'ANTHROPIC_API_KEY not set — agent runtime will return an error on any run. Set the key to enable AI SDR campaigns.',
          );
          return new UnconfiguredLlmClient();
        }
        return new AnthropicLlmClient(apiKey);
      },
    },
  ],
  // Export AgentRunsService so ApprovalsService can notify on
  // action resolution. Export AgentRunProcessor + EmailsService so
  // QueueModule can inject them for the worker dispatch table.
  exports: [
    AgentRuntimeService,
    AgentRunsService,
    AgentRunProcessor,
    EmailsService,
    JobRegistry,
  ],
})
export class AgentRuntimeModule {}
