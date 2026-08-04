// The shell reader's job is narrow: answer "what programs will this command
// line run?" and admit when it cannot. These tests pin both halves — the
// parsing it does correctly, and the syntax it refuses to guess at.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { basename, readShell, tokenize, unwrapShellInvocation } from './shell.js';

describe('tokenize', () => {
  it('splits on whitespace', () => {
    assert.deepEqual(tokenize('git commit -m msg'), ['git', 'commit', '-m', 'msg']);
  });

  it('keeps double-quoted spans as one token', () => {
    assert.deepEqual(tokenize('git commit -m "hello world"'), [
      'git',
      'commit',
      '-m',
      'hello world',
    ]);
  });

  it('keeps single-quoted spans as one token', () => {
    assert.deepEqual(tokenize("sed -i 's/a/b/' f.txt"), [
      'sed',
      '-i',
      's/a/b/',
      'f.txt',
    ]);
  });

  it('honours backslash escapes outside quotes', () => {
    assert.deepEqual(tokenize('cat my\\ file.txt'), ['cat', 'my file.txt']);
  });

  it('honours backslash escapes inside double quotes', () => {
    assert.deepEqual(tokenize('echo "a\\"b"'), ['echo', 'a"b']);
  });

  it('does not treat backslash as an escape inside single quotes', () => {
    assert.deepEqual(tokenize("echo 'a\\b'"), ['echo', 'a\\b']);
  });

  it('preserves an explicitly empty quoted argument', () => {
    // `git commit -m ""` must not silently lose the empty message.
    assert.deepEqual(tokenize('git commit -m ""'), ['git', 'commit', '-m', '']);
  });

  it('collapses runs of whitespace', () => {
    assert.deepEqual(tokenize('  ls   -la  '), ['ls', '-la']);
  });

  it('returns nothing for an empty string', () => {
    assert.deepEqual(tokenize(''), []);
  });
});

describe('readShell — segmentation', () => {
  it('reads a single command as one segment', () => {
    const r = readShell('ls -la');
    assert.equal(r.unreadable, false);
    assert.equal(r.segments.length, 1);
    assert.deepEqual(r.segments[0]!.argv, ['ls', '-la']);
    assert.equal(r.segments[0]!.pipedInto, false);
  });

  it('splits on && and ; and newline', () => {
    for (const sep of ['&&', ';', '\n']) {
      const r = readShell(`npm test ${sep} npm publish`);
      assert.equal(r.segments.length, 2, `separator ${JSON.stringify(sep)}`);
      assert.deepEqual(r.segments[1]!.argv, ['npm', 'publish']);
    }
  });

  it('marks the downstream side of a pipe as pipedInto', () => {
    const r = readShell('curl https://example.com | sh');
    assert.equal(r.segments.length, 2);
    assert.equal(r.segments[0]!.pipedInto, false);
    assert.deepEqual(r.segments[1]!.argv, ['sh']);
    assert.equal(r.segments[1]!.pipedInto, true);
  });

  it('does not treat || as a pipe', () => {
    // `a || b` runs b on failure; it does not feed a's stdout into b.
    const r = readShell('false || sh');
    assert.equal(r.segments.length, 2);
    assert.equal(r.segments[1]!.pipedInto, false);
  });

  it('ignores operators inside quotes', () => {
    const r = readShell('git commit -m "fix && ship"');
    assert.equal(r.segments.length, 1);
    assert.deepEqual(r.segments[0]!.argv, ['git', 'commit', '-m', 'fix && ship']);
  });

  it('drops empty segments from trailing separators', () => {
    const r = readShell('ls;');
    assert.equal(r.segments.length, 1);
  });
});

describe('readShell — refuses to guess', () => {
  const opaque: Array<[string, string]> = [
    ['echo $(whoami)', 'command substitution $(...)'],
    ['echo `whoami`', 'backtick command substitution'],
    ['diff <(a) <(b)', 'process substitution <(...)'],
    ['eval "$CMD"', 'eval'],
  ];

  for (const [command, reason] of opaque) {
    it(`flags ${reason} as unreadable`, () => {
      const r = readShell(command);
      assert.equal(r.unreadable, true, command);
      assert.equal(r.reason, reason);
      // Nothing is reported as a segment — a partial read is worse than none,
      // because the caller would classify only the part we happened to parse.
      assert.equal(r.segments.length, 0);
    });
  }

  it('flags substitution even when it appears late in the line', () => {
    assert.equal(readShell('npm test && rm -rf $(cat target)').unreadable, true);
  });
});

describe('unwrapShellInvocation', () => {
  it('returns the payload of sh -c', () => {
    assert.equal(unwrapShellInvocation(['sh', '-c', 'npm publish']), 'npm publish');
  });

  it('works for every supported shell', () => {
    for (const s of ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']) {
      assert.equal(unwrapShellInvocation([s, '-c', 'ls']), 'ls', s);
    }
  });

  it('resolves the shell through an absolute path', () => {
    assert.equal(unwrapShellInvocation(['/bin/bash', '-c', 'ls']), 'ls');
  });

  it('returns null for a non-shell program', () => {
    assert.equal(unwrapShellInvocation(['node', '-c', 'x']), null);
  });

  it('returns null for a shell invoked without -c', () => {
    assert.equal(unwrapShellInvocation(['bash', 'script.sh']), null);
  });

  it('returns null when -c is the last argument', () => {
    assert.equal(unwrapShellInvocation(['bash', '-c']), null);
  });
});

describe('basename', () => {
  it('strips directories', () => {
    assert.equal(basename('/usr/local/bin/git'), 'git');
  });

  it('strips a .exe suffix', () => {
    assert.equal(basename('C:/tools/git.exe'), 'git');
  });

  it('passes a bare program through', () => {
    assert.equal(basename('git'), 'git');
  });

  it('returns empty for an empty path', () => {
    assert.equal(basename(''), '');
  });
});
