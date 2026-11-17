#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { hasActionableFindings, runAudit } from './audit.js';
import { loadCallsFromPath } from './load.js';
import { normalizeRetellCall } from './normalize-retell.js';
import { renderHtml } from './report-html.js';
import { buildFindingsJson, renderSummary, shareSummaryLine } from './report-text.js';
import type { RunMeta } from './report-text.js';
import { DEFAULT_BASE_URL, fetchCalls, listEndedCallIds, retellClientOptions } from './retell-client.js';
import { sampleCalls } from './samples.js';
import type { NormalizedCall } from './types.js';
import { VERSION } from './version.js';

export const EXIT_OK = 0;
/** At least one high or medium finding. Lets cron or CI notice. */
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;

const HELP = `booking-audit ${VERSION}

Reads your voice agent's call logs and reports bookings that were sent more
than once, bookings the caller never confirmed, spoken "you're booked" claims
with no confirming tool result, and bookings whose outcome is unknown.

Read-only. Runs on your machine. Sends nothing anywhere except the requests to
your own voice platform that fetch your own calls.

Usage
  booking-audit demo                                   See a report in ten seconds.
  RETELL_API_KEY=... booking-audit audit --retell [options]
  booking-audit audit --from <file-or-folder> [options]

  demo runs the audit on built-in, made-up calls. No key, no network.

Source (exactly one)
  --retell                Fetch calls from the Retell API. The key is read from
                          the RETELL_API_KEY environment variable, never from a
                          flag, so it does not land in your shell history.
  --from <path>           Read call objects you already exported as JSON.

Options
  --since <when>          30d, 12h, 2w, or a date like 2026-11-01. Default 30d
                          with --retell. With --from, every call unless set.
  --agent <id>            Only this agent. Repeatable. (--retell)
  --booking-tool <name>   Treat this tool as a booking tool. Repeatable.
                          Replaces auto-detection.
  --identity <a,b>        Arguments that make two calls the same booking.
                          Default: every argument except free-text notes.
  --out <dir>             Where to write the report. Default ./booking-audit-report
  --max-calls <n>         Stop after this many calls. Default 2000.
  --no-redact             Do not mask phone numbers, emails and name-like values.
  --no-cache              Do not keep fetched calls in ./.booking-audit-cache
  --json                  Print findings as JSON and write no files.
  --share-summary         Also print one line of counts, safe to paste publicly.
  -h, --help              Show this help.
  -v, --version           Show the version.

Exit codes
  0  no high or medium findings     1  high or medium findings     2  error
`;

class UsageError extends Error {}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  now: () => number;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

const UNIT_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "30d", "12h", "2w", or anything Date can parse. Returns the window's start in epoch ms. */
export function parseSince(value: string, nowMs: number): number {
  const relative = /^(\d+)([hdw])$/.exec(value.trim());
  if (relative) {
    const unit = UNIT_MS[relative[2] ?? ''];
    if (unit !== undefined) return nowMs - Number(relative[1]) * unit;
  }
  const absolute = Date.parse(value);
  if (Number.isNaN(absolute)) {
    throw new UsageError(`Could not read --since "${value}". Use 30d, 12h, 2w, or a date like 2026-11-01.`);
  }
  if (absolute > nowMs) throw new UsageError(`--since "${value}" is in the future.`);
  return absolute;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

interface AuditFlags {
  /** Run on the built-in synthetic calls. */
  demo: boolean;
  retell: boolean;
  from: string | undefined;
  since: string | undefined;
  agents: string[];
  bookingTools: string[];
  identity: string | undefined;
  out: string | undefined;
  maxCalls: string | undefined;
  noRedact: boolean;
  noCache: boolean;
  json: boolean;
  shareSummary: boolean;
}

async function runAuditCommand(flags: AuditFlags, io: CliIo): Promise<number> {
  if (flags.demo && (flags.retell || flags.from !== undefined)) {
    throw new UsageError('demo runs on built-in calls and takes no source. Use "audit" with --retell or --from.');
  }
  if (!flags.demo && flags.retell === (flags.from !== undefined)) {
    throw new UsageError(
      'Pass exactly one of --retell or --from <path>. Or run "booking-audit demo" to see a report first.',
    );
  }
  const maxCalls = Number(flags.maxCalls ?? '2000');
  if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new UsageError('--max-calls must be a positive whole number.');

  const now = io.now();
  const notes: string[] = [];
  let raws: unknown[];
  let source: string;
  let window: string;
  let sinceMs: number | null = null;

  if (flags.demo) {
    raws = sampleCalls();
    source = 'built-in sample calls (made up, not real data)';
    window = 'demo';
  } else if (flags.retell) {
    const apiKey = io.env['RETELL_API_KEY'];
    if (!apiKey) {
      throw new UsageError(
        'RETELL_API_KEY is not set. Put the key in your environment and rerun. It is never accepted as a flag.',
      );
    }
    sinceMs = parseSince(flags.since ?? '30d', now);
    const cacheDir = flags.noCache ? null : resolve(io.cwd, '.booking-audit-cache', 'retell');
    const client = retellClientOptions(apiKey, {
      baseUrl: io.env['RETELL_API_BASE'] ?? DEFAULT_BASE_URL,
      fetchImpl: io.fetchImpl,
      sleep: io.sleep,
      cacheDir,
      onProgress: (done, total) => {
        if (done % 50 === 0 || done === total) io.stderr(`  fetched ${done} of ${total}`);
      },
    });

    const listed = await listEndedCallIds(client, { fromMs: sinceMs, toMs: now, agentIds: flags.agents, maxCalls });
    io.stderr(`Found ${listed.ids.length} ended calls since ${day(sinceMs)}. Fetching their logs (read-only).`);
    const fetched = await fetchCalls(client, listed.ids);

    raws = fetched.calls;
    source = 'Retell API';
    window = `calls since ${day(sinceMs)}`;
    if (listed.truncated) notes.push(`Stopped at --max-calls ${maxCalls}. Older calls in the window were not scanned.`);
    if (fetched.failed.length > 0) {
      notes.push(`${fetched.failed.length} calls could not be fetched and were not checked.`);
    }
    if (cacheDir) {
      io.stderr(
        `Raw call objects are cached in ${cacheDir}. They contain transcripts. Delete the folder when you are done, or pass --no-cache.`,
      );
    }
  } else {
    const loaded = await loadCallsFromPath(resolve(io.cwd, flags.from ?? ''));
    raws = loaded.raws;
    source = `files in ${flags.from ?? ''}`;
    if (flags.since !== undefined) sinceMs = parseSince(flags.since, now);
    window = sinceMs === null ? 'every call in the files' : `calls since ${day(sinceMs)}`;
    if (loaded.filesFailed.length > 0) {
      notes.push(`${loaded.filesFailed.length} files were not valid JSON and were skipped.`);
    }
    if (raws.length === 0) throw new UsageError(`No call objects found in ${flags.from ?? ''}.`);
  }

  let unreadable = 0;
  let calls: NormalizedCall[] = [];
  for (const raw of raws) {
    const call = normalizeRetellCall(raw);
    if (call) calls.push(call);
    else unreadable += 1;
  }
  if (unreadable > 0) notes.push(`${unreadable} items were not readable call objects and were skipped.`);
  if (!flags.retell && sinceMs !== null) {
    const from = sinceMs;
    // A call with no start time cannot be placed outside the window, so it stays in.
    calls = calls.filter((c) => c.startedAt === null || c.startedAt >= from);
  }
  if (calls.length > maxCalls) {
    calls = calls.slice(0, maxCalls);
    notes.push(`Stopped at --max-calls ${maxCalls}.`);
  }

  const identityKeys = (flags.identity ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const result = runAudit(calls, {
    bookingTools: flags.bookingTools.length > 0 ? flags.bookingTools : null,
    identityKeys: identityKeys.length > 0 ? identityKeys : null,
  });
  result.notes.push(...notes);

  const meta: RunMeta = {
    version: VERSION,
    generatedAt: new Date(now).toISOString(),
    source,
    window,
    redacted: !flags.noRedact,
  };

  if (flags.json) {
    io.stdout(JSON.stringify(buildFindingsJson(result, meta), null, 2));
  } else {
    const outDir = resolve(io.cwd, flags.out ?? (flags.demo ? 'booking-audit-demo' : 'booking-audit-report'));
    await mkdir(outDir, { recursive: true });
    const reportPath = join(outDir, 'report.html');
    await writeFile(reportPath, renderHtml(result, meta), 'utf8');
    await writeFile(join(outDir, 'findings.json'), `${JSON.stringify(buildFindingsJson(result, meta), null, 2)}\n`, 'utf8');
    io.stdout(renderSummary(result, meta, reportPath));
    if (flags.shareSummary) {
      io.stdout('');
      io.stdout('Counts only, safe to paste:');
      io.stdout(shareSummaryLine(result, meta));
    }
  }
  // The demo is supposed to find things. Exiting 1 would read as a crash.
  if (flags.demo) return EXIT_OK;
  return hasActionableFindings(result) ? EXIT_FINDINGS : EXIT_OK;
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        retell: { type: 'boolean' },
        from: { type: 'string' },
        since: { type: 'string' },
        agent: { type: 'string', multiple: true },
        'booking-tool': { type: 'string', multiple: true },
        identity: { type: 'string' },
        out: { type: 'string' },
        'max-calls': { type: 'string' },
        'no-redact': { type: 'boolean' },
        'no-cache': { type: 'boolean' },
        json: { type: 'boolean' },
        'share-summary': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    io.stderr(`booking-audit: ${err instanceof Error ? err.message : String(err)}`);
    io.stderr('Run booking-audit --help for usage.');
    return EXIT_ERROR;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(HELP);
    return EXIT_OK;
  }
  if (values.version) {
    io.stdout(VERSION);
    return EXIT_OK;
  }
  const command = positionals[0] ?? 'audit';
  if (positionals.length > 1 || (command !== 'audit' && command !== 'demo')) {
    io.stderr(`booking-audit: unknown command "${positionals.join(' ')}". The commands are "audit" and "demo".`);
    return EXIT_ERROR;
  }

  try {
    return await runAuditCommand(
      {
        demo: command === 'demo',
        retell: values.retell === true,
        from: values.from,
        since: values.since,
        agents: values.agent ?? [],
        bookingTools: values['booking-tool'] ?? [],
        identity: values.identity,
        out: values.out,
        maxCalls: values['max-calls'],
        noRedact: values['no-redact'] === true,
        noCache: values['no-cache'] === true,
        json: values.json === true,
        shareSummary: values['share-summary'] === true,
      },
      io,
    );
  } catch (err) {
    io.stderr(`booking-audit: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_ERROR;
  }
}

function invokedDirectly(): boolean {
  try {
    const entry = process.argv[1];
    return entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2), {
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
    env: process.env,
    cwd: process.cwd(),
    now: () => Date.now(),
    fetchImpl: fetch,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = EXIT_ERROR;
    },
  );
}
