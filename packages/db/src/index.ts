import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Close the connection pool a `createDb` call opened.
 *
 * `createDb` returns only the drizzle wrapper, so without this the underlying
 * postgres-js pool has no reachable handle and stays open for the life of the
 * process. That is invisible in a long-running server and fatal in a test
 * runner: the event loop never drains, the process never exits, and the
 * workaround for that (`--test-force-exit`) silently truncates the run.
 */
export async function closeDb(db: Database): Promise<void> {
  const client = (db as Database & {
    $client?: { end?: (opts?: { timeout?: number }) => Promise<void> };
  }).$client;
  await client?.end?.({ timeout: 5 });
}

export function createDb(url: string, opts: { prepare?: boolean } = {}): Database {
  const prepare = opts.prepare ?? !isTransactionPooler(url);
  const client = postgres(url, { max: 10, prepare });
  return drizzle(client, { schema });
}

/**
 * Supabase's transaction pooler (Supavisor, *.pooler.supabase.com:6543) does
 * not support prepared statements, which postgres-js uses by default. Detect
 * that connection shape so createDb can fall back to prepare:false without
 * callers having to know about it. Direct connections (port 5432) keep
 * prepared statements.
 */
export function isTransactionPooler(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith('.pooler.supabase.com') || parsed.port === '6543';
  } catch {
    return false;
  }
}

export * from './schema.js';
export { schema };
