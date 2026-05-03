import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { z } from 'zod';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { WebhookService } from './webhook.service.js';
import { AgentsService } from '../agents/agents.service.js';

const CreateSubscription = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url().startsWith('https://').or(z.string().url().startsWith('http://')),
  events: z.array(z.string().min(1)).min(1),
});
type CreateSubscription = z.infer<typeof CreateSubscription>;

const UpdateSubscription = z.object({
  name: z.string().min(1).max(120).optional(),
  url: z.string().url().optional(),
  events: z.array(z.string().min(1)).optional(),
  enabled: z.boolean().optional(),
});
type UpdateSubscription = z.infer<typeof UpdateSubscription>;

@Controller('v1/webhooks')
@UseGuards(ClerkAuthGuard)
export class WebhookController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly agents: AgentsService,
  ) {}

  @Get()
  async list() {
    const orgId = await this.agents.ensureDefaultOrg();
    return this.webhooks.list(orgId);
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateSubscription)) body: CreateSubscription,
  ) {
    const orgId = await this.agents.ensureDefaultOrg();
    return this.webhooks.create({
      orgId,
      name: body.name,
      url: body.url,
      events: body.events,
    });
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateSubscription)) body: UpdateSubscription,
  ) {
    const orgId = await this.agents.ensureDefaultOrg();
    const result = await this.webhooks.update(orgId, id, body);
    if (!result.ok) throw new NotFoundException(`webhook ${id} not found`);
    return { ok: true };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    const orgId = await this.agents.ensureDefaultOrg();
    const ok = await this.webhooks.remove(orgId, id);
    if (!ok) throw new NotFoundException(`webhook ${id} not found`);
  }
}
