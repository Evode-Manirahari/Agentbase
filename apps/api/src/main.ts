import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, trustProxy: true }),
    { bufferLogs: true, rawBody: true },
  );

  await app.register(helmet as any);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[agentbase-api] listening on :${port}`);
}

bootstrap().catch((err) => {
  console.error('[agentbase-api] fatal', err);
  process.exit(1);
});
