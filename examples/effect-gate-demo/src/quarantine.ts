// The half of the story the main demo does not tell.
//
// `start` shows the gate deciding. This shows what happens AFTER a decision,
// which is the part a permissions gateway does not do: a dispatch that is
// interrupted before the provider answers is quarantined rather than retried,
// and only a human can end it.
//
// No process is killed to produce this. The dispatch is given less time than
// the command needs, which is the same condition as a crash from the
// protocol's point of view — the request went out and the answer never came
// back.
//
//   AGENTBASE_DISPATCH_TIMEOUT_MS=500 AGENTBASE_SHELL_ENABLED=1 \
//     pnpm --filter @agentbase/api dev
//   pnpm --filter '@agentbase/effect-gate-demo' quarantine

const BASE_URL = process.env['AGENTBASE_BASE_URL'] ?? 'http://localhost:3002';
const API_KEY = process.env['AGENTBASE_API_KEY'];

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  rose: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

// Slow enough to outlast a short dispatch timeout, and classified `read` so
// policy allows it — the point is the interrupted dispatch, not the gate.
const SLOW_COMMAND = 'find / -maxdepth 4 -name "*.agentbase-nope"';

interface IndeterminateItem {
  receipt_id: string;
  action_id: string;
  attempt: number;
  connector: string;
  idempotency_key_sent: string | null;
  idempotency_mode: string;
  tool: string;
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
      ...(init?.headers ?? {}),
    },
  });
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('✗ AGENTBASE_API_KEY is not set — run ./setup.sh first');
    process.exit(1);
  }

  console.log(c.bold('\n  Agentbase — what happens when a dispatch is interrupted\n'));

  // 1. Send a command the dispatcher will not get an answer for in time.
  console.log(c.dim('  1. Dispatching a command that will outlast the timeout…'));
  console.log(`     ${c.cyan(SLOW_COMMAND)}\n`);

  let requestFailed = false;
  try {
    const res = await apiFetch('/v1/actions/execute', {
      method: 'POST',
      body: JSON.stringify({
        tool: 'shell.run',
        params: { command: SLOW_COMMAND },
      }),
    });
    if (!res.ok) requestFailed = true;
  } catch {
    requestFailed = true;
  }

  if (requestFailed) {
    console.log(
      `  ${c.amber('the request failed')} ${c.dim('— and that is correct. The dispatcher')}\n` +
        c.dim('     stopped waiting, but it does NOT know whether the command ran.\n') +
        c.dim('     Reporting success or failure here would both be guesses.\n'),
    );
  } else {
    console.log(
      c.rose(
        '  The command finished inside the timeout, so nothing was quarantined.\n' +
          '  Restart the API with a shorter AGENTBASE_DISPATCH_TIMEOUT_MS (e.g. 200)\n' +
          '  and run this again.\n',
      ),
    );
    process.exit(1);
  }

  // 2. The attempt is sitting in the operator queue.
  console.log(c.dim('  2. Reading the quarantine queue…\n'));
  const queueRes = await apiFetch('/v1/effects/indeterminate');
  const queue = (await queueRes.json()) as { items: IndeterminateItem[] };
  const mine = queue.items.filter((i) => i.tool === 'shell.run');

  if (mine.length === 0) {
    console.log(c.rose('  Nothing in the queue — expected at least one attempt.\n'));
    process.exit(1);
  }

  const item = mine[0]!;
  console.log(`  ${c.amber('outcome unknown')}  ${c.cyan(item.tool)}`);
  console.log(`  ${c.dim('attempt')}          ${item.attempt} via ${item.connector}`);
  console.log(`  ${c.dim('retry safety')}     ${item.idempotency_mode}`);
  console.log(
    `  ${c.dim('receipt')}          ${item.receipt_id}\n`,
  );
  console.log(
    c.dim(
      '     It will sit here indefinitely. Nothing retries it — retrying an\n' +
        '     effect nobody can account for is what this system exists to stop.\n',
    ),
  );

  // 3. A human establishes what actually happened.
  console.log(c.dim('  3. Resolving it the only way it can be resolved — a human looked…\n'));
  const resolveRes = await apiFetch(`/v1/effects/${item.receipt_id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({
      outcome: 'committed',
      note: 'demo: operator confirmed the command ran',
    }),
  });

  if (!resolveRes.ok) {
    console.log(c.rose(`  resolve failed: ${resolveRes.status} ${await resolveRes.text()}\n`));
    process.exit(1);
  }

  const after = (await (await apiFetch('/v1/effects/indeterminate')).json()) as {
    items: IndeterminateItem[];
  };
  const stillThere = after.items.some((i) => i.receipt_id === item.receipt_id);

  console.log(`  ${c.green('✔ resolved')} ${c.dim('— the verdict is recorded against the attempt,')}`);
  console.log(c.dim('     the action is settled, and the audit log names who decided.\n'));
  console.log(
    `  ${c.dim('still in queue:')} ${stillThere ? c.rose('yes — unexpected') : c.green('no')}\n`,
  );

  if (stillThere) process.exit(1);

  console.log(c.bold('  What a permissions gateway cannot do\n'));
  console.log(
    c.dim(
      '  Deciding whether the call was allowed is settled before anything leaves\n' +
        '  the machine. Everything above happened AFTER that decision — and none of\n' +
        '  it guessed. The one thing nobody knew stayed unknown until a person\n' +
        '  established otherwise.\n',
    ),
  );
}

main().catch((err) => {
  console.error('\n✗ demo failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
