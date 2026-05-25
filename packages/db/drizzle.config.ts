import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://agentbase:agentbase@localhost:5433/agentbase',
  },
  strict: false,
  verbose: true,
} satisfies Config;
