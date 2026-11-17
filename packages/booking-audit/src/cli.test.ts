import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK, main, parseSince } from './cli.js';
import type { CliIo } from './cli.js';
import { cleanCall, threadCall } from './test-helpers.js';
import { VERSION } from './version.js';

const NOW = Date.UTC(2026, 10, 16, 18, 0, 0);

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(argv: string[], io: Partial<CliIo> & { cwd: string }): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    now: () => NOW,
    fetchImpl: (async () => {
      throw new Error('this test should not touch the network');
    }) as typeof fetch,
    sleep: async () => {},
    ...io,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function workdir(files: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'booking-audit-cli-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  return dir;
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe('cli', () => {
  it('prints help and the version', async () => {
    const help = await run(['--help'], { cwd: tmpdir() });
    assert.equal(help.code, EXIT_OK);
    assert.match(help.out, /Read-only\. Runs on your machine\./);
    assert.match(help.out, /never from a\s+flag/);

    const version = await run(['-v'], { cwd: tmpdir() });
    assert.equal(version.out, VERSION);
  });

  it('the version constant matches package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
  });

  it('refuses to guess the source', async () => {
    const neither = await run(['audit'], { cwd: tmpdir() });
    assert.equal(neither.code, EXIT_ERROR);
    assert.match(neither.err, /exactly one of --retell or --from/);

    const both = await run(['audit', '--retell', '--from', 'x'], { cwd: tmpdir() });
    assert.equal(both.code, EXIT_ERROR);
  });

  it('rejects unknown flags and unknown commands', async () => {
    assert.equal((await run(['audit', '--api-key', 'k'], { cwd: tmpdir() })).code, EXIT_ERROR);
    const unknown = await run(['fix'], { cwd: tmpdir() });
    assert.equal(unknown.code, EXIT_ERROR);
    assert.match(unknown.err, /unknown command "fix"/);
  });

  it('never accepts the API key as a flag, and says where it goes', async () => {
    const res = await run(['audit', '--retell'], { cwd: tmpdir() });
    assert.equal(res.code, EXIT_ERROR);
    assert.match(res.err, /RETELL_API_KEY is not set/);
  });

  it('audits a folder of exported calls and writes both reports', async () => {
    const dir = await workdir({ 'a.json': threadCall(), 'b.json': [cleanCall()], 'notes.txt': 'ignored' });
    try {
      const res = await run(['audit', '--from', '.'], { cwd: dir });
      assert.equal(res.code, EXIT_FINDINGS);
      assert.match(res.out, /Calls scanned: 2/);
      assert.match(res.out, /F1 {2}Repeated booking\s+1 {2}\(1 high\)/);
      assert.match(res.out, /F2 {2}Booking the caller never confirmed\s+1 {2}\(1 high\)/);

      const html = await readFile(join(dir, 'booking-audit-report', 'report.html'), 'utf8');
      assert.match(html, /call_thread/);
      const findings = JSON.parse(await readFile(join(dir, 'booking-audit-report', 'findings.json'), 'utf8')) as {
        redacted: boolean;
        calls: { callId: string; findings: { check: string }[] }[];
      };
      assert.equal(findings.redacted, true);
      assert.deepEqual(
        findings.calls.map((c) => [c.callId, c.findings.map((f) => f.check)]),
        [['call_thread', ['F1', 'F2']]],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 when there is nothing to act on', async () => {
    const dir = await workdir({ 'calls.json': { items: [cleanCall('c1'), cleanCall('c2')] } });
    try {
      const res = await run(['--from', 'calls.json', '--out', 'r'], { cwd: dir });
      assert.equal(res.code, EXIT_OK);
      assert.match(res.out, /No findings in 2 calls\./);
      assert.equal(await exists(join(dir, 'r', 'report.html')), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--json prints the findings and writes nothing', async () => {
    const dir = await workdir({ 'a.json': threadCall() });
    try {
      const res = await run(['audit', '--from', 'a.json', '--json'], { cwd: dir });
      assert.equal(res.code, EXIT_FINDINGS);
      assert.equal((JSON.parse(res.out) as { tool: string }).tool, 'booking-audit');
      assert.equal(await exists(join(dir, 'booking-audit-report')), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--share-summary adds one line of counts', async () => {
    const dir = await workdir({ 'a.json': threadCall() });
    try {
      const res = await run(['audit', '--from', 'a.json', '--share-summary'], { cwd: dir });
      assert.match(res.out, /Counts only, safe to paste:\nbooking-audit 0\.1\.0 \| calls=1 attempts=7 /);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--booking-tool replaces detection, and a wrong name is visible', async () => {
    const dir = await workdir({ 'a.json': threadCall() });
    try {
      const res = await run(['audit', '--from', 'a.json', '--booking-tool', 'commit_visit'], { cwd: dir });
      assert.equal(res.code, EXIT_OK);
      assert.match(res.out, /Booking tools detected: none/);
      assert.match(res.out, /No booking tool was detected\. Tools seen: Book_Appointment\./);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names what it skipped: unreadable items and broken files', async () => {
    const dir = await workdir({ 'a.json': [cleanCall(), { not: 'a call' }], 'broken.json': '{nope' });
    try {
      const res = await run(['audit', '--from', '.'], { cwd: dir });
      assert.equal(res.code, EXIT_OK);
      assert.match(res.out, /1 files were not valid JSON and were skipped\./);
      assert.match(res.out, /1 items were not readable call objects and were skipped\./);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails clearly on an empty or missing folder', async () => {
    const dir = await workdir({});
    try {
      assert.match((await run(['audit', '--from', '.'], { cwd: dir })).err, /No call objects found/);
      assert.match((await run(['audit', '--from', 'missing'], { cwd: dir })).err, /No such file or folder/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--since filters exported calls by start time', async () => {
    const old = { ...cleanCall('old'), start_timestamp: Date.UTC(2026, 0, 1) };
    const recent = { ...threadCall(), start_timestamp: NOW - 86_400_000 };
    const dir = await workdir({ 'a.json': [old, recent] });
    try {
      const res = await run(['audit', '--from', 'a.json', '--since', '7d'], { cwd: dir });
      assert.match(res.out, /Calls scanned: 1/);
      assert.match(res.out, /calls since 2026-11-09/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs end to end against the Retell API shape, caches outside the report, and reruns offline', async () => {
    const dir = await workdir({});
    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/v3/list-calls') {
        return Response.json({
          items: [
            { call_id: 'call_thread', call_status: 'ended' },
            { call_id: 'call_clean', call_status: 'ended' },
          ],
          has_more: false,
        });
      }
      return Response.json(url.pathname.endsWith('call_thread') ? threadCall() : cleanCall());
    }) as typeof fetch;
    const env = { RETELL_API_KEY: 'key_test', RETELL_API_BASE: 'https://retell.test' };

    try {
      const first = await run(['audit', '--retell', '--since', '30d'], { cwd: dir, env, fetchImpl });
      assert.equal(first.code, EXIT_FINDINGS);
      assert.match(first.out, /booking-audit 0\.1\.0 {2}\(Retell API, calls since 2026-10-17\)/);
      assert.match(first.err, /Found 2 ended calls since 2026-10-17\. Fetching their logs \(read-only\)\./);
      assert.match(first.err, /Raw call objects are cached in .*\.booking-audit-cache/);
      assert.deepEqual(requests, ['POST /v3/list-calls', 'GET /v2/get-call/call_thread', 'GET /v2/get-call/call_clean']);
      // Raw transcripts and the shareable report live in different folders.
      assert.equal(await exists(join(dir, '.booking-audit-cache', 'retell', 'call_thread.json')), true);
      assert.equal(await exists(join(dir, 'booking-audit-report', '.booking-audit-cache')), false);

      requests.length = 0;
      await run(['audit', '--retell'], { cwd: dir, env, fetchImpl });
      assert.deepEqual(requests, ['POST /v3/list-calls']);

      requests.length = 0;
      await rm(join(dir, '.booking-audit-cache'), { recursive: true, force: true });
      await run(['audit', '--retell', '--no-cache'], { cwd: dir, env, fetchImpl });
      assert.equal(requests.length, 3);
      assert.equal(await exists(join(dir, '.booking-audit-cache')), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('demo', () => {
  it('writes a report from built-in calls with no key and no network, and exits 0', async () => {
    const dir = await workdir({});
    try {
      const res = await run(['demo'], { cwd: dir });
      assert.equal(res.code, EXIT_OK);
      assert.match(res.out, /built-in sample calls \(made up, not real data\)/);
      assert.match(res.out, /Calls scanned: 7/);
      assert.match(res.out, /F1 {2}Repeated booking\s+2 {2}\(1 high, 1 low\)/);
      assert.match(res.out, /F2 {2}Booking the caller never confirmed\s+1 {2}\(1 high\)/);
      assert.match(res.out, /F3 {2}Unverified booking claim\s+2 {2}\(2 high\)/);
      assert.match(res.out, /F4 {2}Unknown booking outcome\s+2 {2}\(2 medium\)/);
      assert.match(res.out, /5 of 7 calls have findings\./);

      const html = await readFile(join(dir, 'booking-audit-demo', 'report.html'), 'utf8');
      assert.match(html, /demo_five_in_one_turn/);
      // The made-up caller's number is masked like a real one would be.
      assert.doesNotMatch(html, /555-0142/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('takes no source', async () => {
    const res = await run(['demo', '--from', 'x'], { cwd: tmpdir() });
    assert.equal(res.code, EXIT_ERROR);
    assert.match(res.err, /demo runs on built-in calls/);
  });
});

describe('--since', () => {
  it('reads relative windows and dates', () => {
    assert.equal(parseSince('30d', NOW), NOW - 30 * 86_400_000);
    assert.equal(parseSince('12h', NOW), NOW - 12 * 3_600_000);
    assert.equal(parseSince('2w', NOW), NOW - 14 * 86_400_000);
    assert.equal(parseSince('2026-11-01', NOW), Date.UTC(2026, 10, 1));
  });

  it('rejects nonsense and the future', () => {
    assert.throws(() => parseSince('soon', NOW), /Could not read --since/);
    assert.throws(() => parseSince('2027-01-01', NOW), /in the future/);
  });
});
