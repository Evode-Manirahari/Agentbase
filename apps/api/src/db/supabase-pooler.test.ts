// Unit tests for the Supabase transaction-pooler detection in @agentbase/db.
// The pooler (Supavisor, port 6543) rejects prepared statements, so createDb
// must detect it and postgres-js must run with prepare:false there.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { isTransactionPooler } from '@agentbase/db';

describe('isTransactionPooler', () => {
  it('detects the Supabase transaction pooler hostname', () => {
    assert.equal(
      isTransactionPooler(
        'postgresql://postgres.abcdefgh:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres',
      ),
      true,
    );
  });

  it('detects port 6543 on any host', () => {
    assert.equal(isTransactionPooler('postgresql://u:p@db.example.com:6543/app'), true);
  });

  it('treats a Supabase direct connection (5432) as non-pooler', () => {
    assert.equal(
      isTransactionPooler('postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres'),
      false,
    );
  });

  it('treats local docker-compose Postgres as non-pooler', () => {
    assert.equal(
      isTransactionPooler('postgresql://agentbase:agentbase@localhost:5433/agentbase'),
      false,
    );
  });

  it('returns false for garbage input instead of throwing', () => {
    assert.equal(isTransactionPooler('not-a-url'), false);
  });
});
