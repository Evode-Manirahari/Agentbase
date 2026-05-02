import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://dejavas:dejavas@localhost:5433/dejavas',
  },
  strict: false,
  verbose: true,
} satisfies Config;
