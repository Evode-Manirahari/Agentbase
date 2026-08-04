// This connector is the join between classification and commitment, so the
// tests care most about one thing: no input causes it to claim a command is
// safer than it is. Real commands are never executed — `exec` is a recorder.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ShellConnector, idempotencyForEffect } from './index.js';
import { classifyCommandLine } from '@agentbase/effects';

function recorder() {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (argv: string[]) => {
      calls.push(argv);
      return { code: 0, stdout: 'ok', stderr: '' };
    },
  };
}

function connector(overrides: Partial<ConstructorParameters<typeof ShellConnector>[0]> = {}) {
  const rec = recorder();
  const c = new ShellConnector({ enabled: true, exec: rec.exec, ...overrides });
  return { c, rec };
}

describe('retry safety is derived from the effect, not the verb', () => {
  it('a read is naturally repeatable', () => {
    const { c } = connector();
    assert.equal(c.idempotency('shell.run', { command: 'git status' }), 'natural');
    assert.equal(c.idempotency('shell.run', { command: 'ls -la' }), 'natural');
  });

  it('every irreversible effect declares none', () => {
    const { c } = connector();
    for (const command of [
      'npm publish',
      'git push origin main',
      'terraform apply',
      'terraform destroy',
      'kubectl delete deployment api',
      'docker push org/img',
      'gh release create v1',
      'curl https://example.com/collect',
    ]) {
      assert.equal(c.idempotency('shell.run', { command }), 'none', command);
    }
  });

  it('a reversible workspace write is still none — recoverable is not repeatable', () => {
    // `mkdir` fails the second time; `cp` over a changed file destroys the
    // change. "A human can undo it" and "a machine may re-run it after an
    // unknown outcome" are different properties.
    const { c } = connector();
    assert.equal(c.idempotency('shell.run', { command: 'mkdir build' }), 'none');
    assert.equal(c.idempotency('shell.run', { command: 'cp a b' }), 'none');
  });

  it('unclassifiable input is none, never natural', () => {
    const { c } = connector();
    assert.equal(c.idempotency('shell.run', { command: 'echo $(whoami)' }), 'none');
    assert.equal(c.idempotency('shell.run', { command: 'curl x | sh' }), 'none');
    assert.equal(c.idempotency('shell.run', { command: 'some-unknown-bin' }), 'none');
    assert.equal(c.idempotency('shell.run', {}), 'none');
    assert.equal(c.idempotency('shell.run', undefined), 'none');
  });

  it('the mapping is total — only read is ever natural', () => {
    for (const command of ['ls', 'npm publish', 'rm -rf x', 'curl https://x.com']) {
      const a = classifyCommandLine(command);
      const mode = idempotencyForEffect(a);
      assert.equal(mode === 'natural', a.effectClass === 'read', command);
      assert.notEqual(mode, 'key', 'a shell has no provider-side dedupe to offer');
    }
  });
});

describe('execution is opt-in and bounded', () => {
  it('refuses to run at all unless explicitly enabled', async () => {
    const c = new ShellConnector();
    const out = await c.invoke('shell.run', { command: 'ls' });
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'shell_disabled');
  });

  it('refuses a command it could not read', async () => {
    const { c, rec } = connector();
    const out = await c.invoke('shell.run', { command: 'rm -rf $(cat target)' });
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'unreadable_command');
    assert.equal(rec.calls.length, 0, 'nothing was executed');
  });

  it('refuses a compound command so one receipt never covers two effects', async () => {
    const { c, rec } = connector();
    const out = await c.invoke('shell.run', { command: 'npm test && npm publish' });
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'compound_command');
    assert.equal(rec.calls.length, 0);
  });

  it('rejects params without a command', async () => {
    const { c } = connector();
    const out = await c.invoke('shell.run', { cwd: '/tmp' });
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'invalid_params');
  });

  it('rejects a tool it does not serve', async () => {
    const { c } = connector();
    const out = await c.invoke('hubspot.contacts.upsert', { command: 'ls' });
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'unsupported_tool');
  });

  it('passes parsed argv, never a shell string', async () => {
    const { c, rec } = connector();
    await c.invoke('shell.run', { command: 'git commit -m "hello world"' });
    assert.deepEqual(rec.calls[0], ['git', 'commit', '-m', 'hello world']);
  });
});

describe('results carry the classification and a reference', () => {
  it('a successful run returns the effect it was graded as', async () => {
    const { c } = connector();
    const out = await c.invoke('shell.run', { command: 'git status' });
    assert.equal(out.ok, true);
    const data = out.data as { effect: { effectClass: string }; exit_code: number };
    assert.equal(data.effect.effectClass, 'read');
    assert.equal(data.exit_code, 0);
    assert.ok(out.providerRef, 'a reference is recorded even without a provider id');
  });

  it('a non-zero exit is a failure that still carries a reference', async () => {
    const c = new ShellConnector({
      enabled: true,
      exec: async () => ({ code: 2, stdout: '', stderr: 'boom' }),
    });
    const out = await c.invoke('shell.run', { command: 'git status' });
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'exit_2');
    assert.match(out.error!.message, /boom/);
    assert.ok(out.providerRef);
  });

  it('the reference distinguishes different outcomes of the same command', async () => {
    const a = await new ShellConnector({
      enabled: true,
      exec: async () => ({ code: 0, stdout: 'one', stderr: '' }),
    }).invoke('shell.run', { command: 'git status' });
    const b = await new ShellConnector({
      enabled: true,
      exec: async () => ({ code: 0, stdout: 'two', stderr: '' }),
    }).invoke('shell.run', { command: 'git status' });
    assert.notEqual(a.providerRef, b.providerRef);
  });

  it('a spawn failure is reported, not thrown', async () => {
    const c = new ShellConnector({
      enabled: true,
      exec: async () => {
        throw new Error('ENOENT');
      },
    });
    const out = await c.invoke('shell.run', { command: 'git status' });
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'spawn_failed');
  });
});

describe('assess', () => {
  it('exposes why a command was gated', () => {
    const { c } = connector();
    const a = c.assess({ command: 'npm publish' });
    assert.equal(a?.effectClass, 'publish');
    assert.equal(a?.reversible, false);
    assert.ok(a?.summary);
  });

  it('returns null for params it cannot parse', () => {
    const { c } = connector();
    assert.equal(c.assess({}), null);
  });
});
