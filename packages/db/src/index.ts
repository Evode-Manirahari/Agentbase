import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(url: string): Database {
  const client = postgres(url, { max: 10 });
  return drizzle(client, { schema });
}

export * from './schema.js';
export { schema };
