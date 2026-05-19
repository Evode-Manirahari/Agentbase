import { Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActionsModule } from '../actions/actions.module.js';
import { AgentRuntimeService } from './agent-runtime.service.js';
import { JobRegistry } from './job.js';
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

@Module({
  imports: [ActionsModule],
  providers: [
    AgentRuntimeService,
    {
      provide: JobRegistry,
      useFactory: () => {
        const registry = new JobRegistry();
        registry.register(AI_SDR_OUTBOUND_JOB);
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
  exports: [AgentRuntimeService, JobRegistry],
})
export class AgentRuntimeModule {}
