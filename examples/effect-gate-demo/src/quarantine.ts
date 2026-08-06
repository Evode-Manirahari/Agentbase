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

  // A failed HTTP request is the SUCCESS condition here: it means the
  // dispatcher stopped waiting without an answer. Every other outcome needs
  // telling apart, because they need opposite fixes and the response code
  // alone cannot distinguish them — a denial and a completed command are both
  // a perfectly ordinary 201.
  let requestFailed = false;
  let status: string | null = null;
  let denyReason: string | null = null;
  try {
    const res = await apiFetch('/v1/actions/execute', {
      method: 'POST',
      body: JSON.stringify({
        tool: 'shell.run',
        params: { command: SLOW_COMMAND },
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        status?: string;
        policy_decision?: { reason?: string };
      };
      status = body.status ?? null;
      denyReason = body.policy_decision?.reason ?? null;
    } else if (res.status >= 500) {
      // The condition being demonstrated: the dispatcher gave up waiting.
      requestFailed = true;
    } else {
      // A 4xx is this demo being held wrong, not an interrupted dispatch —
      // most often a stale or unexported API key. Treating every failed
      // request as the quarantine condition made a rejected key look like a
      // successful demonstration, and the run then failed further down with
      // "nothing in the queue".
      console.log(
        c.rose(`  The API rejected the request (HTTP ${res.status}).\n`) +
          c.dim(`     ${(await res.text()).slice(0, 200)}\n\n`) +
          c.dim(
            res.status === 401 || res.status === 403
              ? '     That is an auth failure, not an interrupted dispatch. Mint a\n' +
                  '     fresh key and export it:\n\n'
              : '     That is a request problem, not an interrupted dispatch. Re-run\n' +
                  '     setup and export the key it prints:\n\n',
          ) +
          `       ${c.cyan('./examples/effect-gate-demo/setup.sh')}\n` +
          `       ${c.cyan('export AGENTBASE_API_KEY=agb_…')}\n`,
      );
      process.exit(1);
    }
  } catch (err) {
    // fetch throws when nothing answered at all. If the API is simply not
    // running, that is a setup problem wearing the costume of the thing this
    // demo exists to show, so it is checked before the dispatch rather than
    // inferred from the failure.
    console.log(
      c.rose(`  Could not reach the API at ${BASE_URL}.\n`) +
        c.dim(`     ${err instanceof Error ? err.message : String(err)}\n\n`) +
        c.dim('     Start it with a dispatch timeout shorter than the command needs:\n\n') +
        `       ${c.cyan('AGENTBASE_DISPATCH_TIMEOUT_MS=50 AGENTBASE_SHELL_ENABLED=1 \\')}\n` +
        `       ${c.cyan('  AGENTBASE_ALLOW_UNAUTHENTICATED=1 pnpm --filter @agentbase/api dev')}\n`,
    );
    process.exit(1);
  }

  if (requestFailed) {
    console.log(
      `  ${c.amber('the request failed')} ${c.dim('— and that is correct. The dispatcher')}\n` +
        c.dim('     stopped waiting, but it does NOT know whether the command ran.\n') +
        c.dim('     Reporting success or failure here would both be guesses.\n'),
    );
  } else if (status === 'denied') {
    // The most likely cause by far, and the one that used to be reported as a
    // timeout problem. The demo's policy is the org's ONE active policy, so
    // anything that installs another — the dashboard editor, the e2e suite —
    // silently replaces it, and this read-only command then matches no rule
    // and falls through to `default: deny`. Lowering the timeout can never fix
    // that, which is what the old message advised.
    console.log(
      c.rose('  The gate denied the command, so no dispatch was ever attempted.\n') +
        c.dim(`     policy said: ${denyReason ?? 'no reason given'}\n\n`) +
        c.dim('     This command is a read and the effect-gate policy allows reads,\n') +
        c.dim('     so the active policy is almost certainly not that one — installing\n') +
        c.dim('     any other policy replaces it. Reinstall it and run this again:\n\n') +
        `       ${c.cyan('./examples/effect-gate-demo/setup.sh')}\n`,
    );
    process.exit(1);
  } else if (status === 'awaiting_approval') {
    console.log(
      c.rose('  The gate held the command for approval, so no dispatch was attempted.\n') +
        c.dim('     This demo needs a command that runs unattended. The active policy\n') +
        c.dim('     is not the effect-gate one — reinstall it and run this again:\n\n') +
        `       ${c.cyan('./examples/effect-gate-demo/setup.sh')}\n`,
    );
    process.exit(1);
  } else {
    // The genuine timeout case: allowed, dispatched, and answered in time.
    console.log(
      c.rose(
        `  The command completed inside the timeout (status: ${status ?? 'unknown'}),\n` +
          '  so nothing was quarantined. The dispatch has to be given LESS time than\n' +
          '  the command needs — on a fast machine this one can finish quickly.\n\n',
      ) +
        c.dim('     Restart the API with a shorter timeout and run this again:\n\n') +
        `       ${c.cyan('AGENTBASE_DISPATCH_TIMEOUT_MS=25 AGENTBASE_SHELL_ENABLED=1 \\')}\n` +
        `       ${c.cyan('  AGENTBASE_ALLOW_UNAUTHENTICATED=1 pnpm --filter @agentbase/api dev')}\n`,
    );
    process.exit(1);
  }

  // 2. The attempt is sitting in the operator queue.
  console.log(c.dim('  2. Reading the quarantine queue…\n'));
  const queueRes = await apiFetch('/v1/effects/indeterminate');
  const queue = (await queueRes.json()) as { items: IndeterminateItem[] };
  const mine = queue.items.filter((i) => i.tool === 'shell.run');

  if (mine.length === 0) {
    // A 5xx is what an interrupted dispatch looks like from out here, but it
    // is not exclusively that — the API has no distinct status for "the
    // dispatcher stopped waiting", so an ordinary internal error arrives
    // looking identical. The difference is observable only here: a real
    // interruption always leaves an attempt behind, because the attempt is
    // written BEFORE the request goes out. Nothing in the queue means nothing
    // was ever dispatched.
    console.log(
      c.rose('  The request failed, but nothing was quarantined.\n\n') +
        c.dim('     An interrupted dispatch always leaves an attempt — it is recorded\n') +
        c.dim('     before the request leaves. So this was an internal error on the\n') +
        c.dim('     way to the dispatch, not an interrupted one. Check the API log.\n'),
    );
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
