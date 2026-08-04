// A deliberately small shell reader. It exists to answer one question — "what
// programs is this command line going to run?" — and nothing else.
//
// It is NOT a shell, and it does not try to be. Anything it cannot read
// confidently is surfaced as unreadable so the classifier can fail closed
// rather than quietly returning a benign answer for a command it misunderstood.

export interface ShellSegment {
  argv: string[];
  // True when this segment's stdin comes from a pipe. `curl x | sh` is a very
  // different proposition from `sh script.sh`.
  pipedInto: boolean;
}

export interface ShellReading {
  segments: ShellSegment[];
  // Set when we hit syntax we refuse to guess at: command substitution,
  // process substitution, eval, backticks. The classifier treats this as
  // grounds for `unknown`.
  unreadable: boolean;
  reason?: string;
}

const OPERATORS = ['&&', '||', ';', '|', '\n'];

// Constructs that can execute text we cannot see at classification time.
const OPAQUE = [
  { pattern: /\$\(/, reason: 'command substitution $(...)' },
  { pattern: /`/, reason: 'backtick command substitution' },
  { pattern: /<\(/, reason: 'process substitution <(...)' },
  { pattern: /\beval\b/, reason: 'eval' },
];

export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        cur += input[++i]!;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i]!;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || started) {
        out.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (cur || started) out.push(cur);
  return out;
}

export function readShell(command: string): ShellReading {
  for (const { pattern, reason } of OPAQUE) {
    if (pattern.test(command)) {
      return { segments: [], unreadable: true, reason };
    }
  }

  const segments: ShellSegment[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  let nextIsPiped = false;

  const flush = (piped: boolean) => {
    const argv = tokenize(buf).filter((t) => t.length > 0);
    if (argv.length > 0) segments.push({ argv, pipedInto: piped });
    buf = '';
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    const matched = OPERATORS.find((op) =>
      op.length === 2 ? two === op : ch === op,
    );
    if (matched) {
      const wasPiped = nextIsPiped;
      // `|` (but not `||`) pipes this segment's output into the next one.
      nextIsPiped = matched === '|';
      flush(wasPiped);
      i += matched.length - 1;
      continue;
    }
    buf += ch;
  }
  flush(nextIsPiped);

  return { segments, unreadable: false };
}

// `bash -c "..."`, `sh -c '...'`, `zsh -c ...` — unwrap so we classify what is
// actually going to run rather than the shell that runs it.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

export function unwrapShellInvocation(argv: string[]): string | null {
  const program = basename(argv[0] ?? '');
  if (!SHELLS.has(program)) return null;
  const cIndex = argv.findIndex((a) => a === '-c');
  if (cIndex === -1) return null;
  return argv[cIndex + 1] ?? null;
}

export function basename(p: string): string {
  const cleaned = p.split('/').pop() ?? p;
  return cleaned.endsWith('.exe') ? cleaned.slice(0, -4) : cleaned;
}
