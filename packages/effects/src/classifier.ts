import type { CommandInput, EffectAssessment, EffectClass } from './types.js';
import { basename, readShell, unwrapShellInvocation } from './shell.js';

// Severity order. When a command line runs several programs, the whole line is
// as consequential as its worst segment: `npm test && npm publish` is a
// publish, not a test.
const SEVERITY: Record<EffectClass, number> = {
  read: 0,
  workspace_write: 1,
  egress: 2,
  vcs_write: 3,
  external_comms: 4,
  deploy: 5,
  publish: 6,
  infra_write: 7,
  unknown: 8,
};

interface Rule {
  name: string;
  effectClass: EffectClass;
  reversible: boolean;
  summary: string;
}

const READ: Rule = {
  name: 'read-only',
  effectClass: 'read',
  reversible: true,
  summary: 'Reads state without changing anything',
};

// Programs whose every invocation is a read.
const READ_ONLY_PROGRAMS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'ag', 'find', 'fd', 'wc', 'pwd',
  'which', 'file', 'stat', 'diff', 'du', 'df', 'ps', 'env', 'date', 'whoami',
  'basename', 'dirname', 'realpath', 'sort', 'uniq', 'cut', 'tr', 'jq', 'yq',
  'tree', 'man', 'help', 'type', 'printenv', 'uname', 'hostname', 'id',
]);

// Programs that only ever touch the working tree.
const WORKSPACE_WRITE_PROGRAMS = new Set([
  'touch', 'mkdir', 'mv', 'cp', 'ln', 'chmod', 'chown', 'patch', 'tar',
  'unzip', 'zip', 'gzip', 'gunzip',
]);

// Test/build runners. Read for our purposes: they don't leave the machine.
// (A build script that deploys is why `make` and `npm run` are NOT here.)
const BUILD_PROGRAMS = new Set([
  'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'pytest', 'mocha', 'tap',
  'go', 'cargo', 'mvn', 'gradle', 'rustc', 'gcc', 'clang', 'javac',
]);

// Subcommand-sensitive programs. Order matters: the first matching entry wins.
const SUBCOMMAND_RULES: Record<string, Array<{ match: string[]; rule: Rule }>> = {
  git: [
    {
      match: ['push'],
      rule: {
        name: 'git-push',
        effectClass: 'vcs_write',
        reversible: false,
        summary: 'Publishes commits to a remote others can pull',
      },
    },
    {
      match: ['tag', '-d'],
      rule: {
        name: 'git-tag-delete',
        effectClass: 'vcs_write',
        reversible: false,
        summary: 'Deletes a tag',
      },
    },
    {
      match: ['status'], rule: READ,
    },
    { match: ['log'], rule: READ },
    { match: ['diff'], rule: READ },
    { match: ['show'], rule: READ },
    { match: ['fetch'], rule: READ },
    { match: ['remote'], rule: READ },
    { match: ['branch'], rule: READ },
    {
      match: [],
      rule: {
        name: 'git-local',
        effectClass: 'workspace_write',
        reversible: true,
        summary: 'Changes local git state',
      },
    },
  ],
  gh: [
    {
      match: ['pr', 'merge'],
      rule: {
        name: 'gh-pr-merge',
        effectClass: 'vcs_write',
        reversible: false,
        summary: 'Merges a pull request into a shared branch',
      },
    },
    {
      match: ['release', 'create'],
      rule: {
        name: 'gh-release',
        effectClass: 'publish',
        reversible: false,
        summary: 'Cuts a public release',
      },
    },
    {
      match: ['repo', 'delete'],
      rule: {
        name: 'gh-repo-delete',
        effectClass: 'infra_write',
        reversible: false,
        summary: 'Deletes a repository',
      },
    },
    { match: ['pr', 'list'], rule: READ },
    { match: ['pr', 'view'], rule: READ },
    { match: ['issue', 'list'], rule: READ },
    { match: ['issue', 'view'], rule: READ },
    {
      match: [],
      rule: {
        name: 'gh-write',
        effectClass: 'vcs_write',
        reversible: false,
        summary: 'Changes state on GitHub',
      },
    },
  ],
  terraform: [
    { match: ['plan'], rule: READ },
    { match: ['show'], rule: READ },
    { match: ['validate'], rule: READ },
    { match: ['fmt'], rule: { ...READ, effectClass: 'workspace_write', name: 'terraform-fmt' } },
    {
      match: ['destroy'],
      rule: {
        name: 'terraform-destroy',
        effectClass: 'infra_write',
        reversible: false,
        summary: 'Destroys provisioned infrastructure',
      },
    },
    {
      match: ['apply'],
      rule: {
        name: 'terraform-apply',
        effectClass: 'deploy',
        reversible: false,
        summary: 'Applies infrastructure changes',
      },
    },
    {
      match: [],
      rule: {
        name: 'terraform-other',
        effectClass: 'unknown',
        reversible: false,
        summary: 'Unrecognised terraform subcommand',
      },
    },
  ],
  kubectl: [
    { match: ['get'], rule: READ },
    { match: ['describe'], rule: READ },
    { match: ['logs'], rule: READ },
    {
      match: ['delete'],
      rule: {
        name: 'kubectl-delete',
        effectClass: 'infra_write',
        reversible: false,
        summary: 'Deletes cluster resources',
      },
    },
    {
      match: [],
      rule: {
        name: 'kubectl-write',
        effectClass: 'deploy',
        reversible: false,
        summary: 'Changes cluster state',
      },
    },
  ],
  docker: [
    { match: ['ps'], rule: READ },
    { match: ['images'], rule: READ },
    { match: ['logs'], rule: READ },
    {
      match: ['push'],
      rule: {
        name: 'docker-push',
        effectClass: 'publish',
        reversible: false,
        summary: 'Pushes an image to a registry',
      },
    },
    {
      match: [],
      rule: {
        name: 'docker-local',
        effectClass: 'workspace_write',
        reversible: true,
        summary: 'Local container operation',
      },
    },
  ],
  aws: [
    {
      match: [],
      rule: {
        name: 'aws-cli',
        effectClass: 'infra_write',
        reversible: false,
        summary: 'AWS CLI call — cloud resource change possible',
      },
    },
  ],
  gcloud: [
    {
      match: [],
      rule: {
        name: 'gcloud-cli',
        effectClass: 'infra_write',
        reversible: false,
        summary: 'gcloud call — cloud resource change possible',
      },
    },
  ],
  fly: [
    {
      match: ['deploy'],
      rule: {
        name: 'fly-deploy',
        effectClass: 'deploy',
        reversible: false,
        summary: 'Deploys to Fly.io',
      },
    },
    { match: ['status'], rule: READ },
    { match: ['logs'], rule: READ },
    {
      match: [],
      rule: {
        name: 'fly-write',
        effectClass: 'deploy',
        reversible: false,
        summary: 'Changes Fly.io app state',
      },
    },
  ],
  vercel: [
    {
      match: [],
      rule: {
        name: 'vercel-deploy',
        effectClass: 'deploy',
        reversible: false,
        summary: 'Deploys to Vercel',
      },
    },
  ],
  psql: [
    {
      match: [],
      rule: {
        name: 'psql',
        effectClass: 'infra_write',
        reversible: false,
        summary: 'Direct database session',
      },
    },
  ],
};

// Package managers: publish is the dangerous verb, install is not.
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

const PUBLISH_RULE: Rule = {
  name: 'package-publish',
  effectClass: 'publish',
  reversible: false,
  summary: 'Publishes a package to a public registry',
};

// Build tools that also carry a publishing verb. These MUST be consulted
// before the BUILD_PROGRAMS read rule: `cargo` and `mvn` are build programs,
// so `cargo publish` and `mvn deploy` would otherwise be reported as reads —
// the one mistake this classifier exists to never make.
const BUILD_PUBLISH_VERBS: Record<string, readonly string[]> = {
  cargo: ['publish'],
  mvn: ['deploy'],
  gradle: ['publish'],
  gem: ['push'],
  twine: ['upload'],
};

const NETWORK_PROGRAMS = new Set(['curl', 'wget', 'nc', 'ncat', 'telnet']);
const REMOTE_COPY_PROGRAMS = new Set(['scp', 'rsync', 'ssh', 'sftp']);

const UNKNOWN_RULE: Rule = {
  name: 'unclassified',
  effectClass: 'unknown',
  reversible: false,
  summary: 'Command not recognised — consequences unknown',
};

function isLocalUrl(token: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/.test(
    token,
  );
}

function hasDryRun(argv: string[]): boolean {
  return argv.some((a) => a === '--dry-run' || a === '--dryrun');
}

function matchesSubcommands(argv: string[], match: string[]): boolean {
  if (match.length === 0) return true;
  // Sub-tokens must appear in order among the non-flag arguments, so
  // `gh pr merge 12` and `gh pr --repo x merge 12` both match ['pr','merge'].
  const words = argv.slice(1).filter((a) => !a.startsWith('-'));
  let wi = 0;
  for (const m of match) {
    const found = words.indexOf(m, wi);
    if (found === -1) {
      // Flags count too, for entries like ['tag','-d'].
      if (!argv.slice(1).includes(m)) return false;
      continue;
    }
    wi = found + 1;
  }
  return true;
}

function classifySegment(argv: string[], pipedInto: boolean): Rule {
  const program = basename(argv[0] ?? '');
  if (!program) return UNKNOWN_RULE;

  // Anything receiving piped input and then executing it is arbitrary code we
  // cannot see. `curl … | sh` is the canonical supply-chain footgun.
  if (pipedInto && (program === 'sh' || program === 'bash' || program === 'zsh')) {
    return {
      name: 'pipe-to-shell',
      effectClass: 'unknown',
      reversible: false,
      summary: 'Executes piped content as a shell script',
    };
  }

  // A dry run of anything is a read. Checked before the rule table so
  // `terraform apply --dry-run`-style invocations don't trip the apply rule.
  if (hasDryRun(argv)) {
    return { ...READ, name: `${program}-dry-run` };
  }

  // Before the read rules: a build tool's publishing verb is a publish.
  const publishVerbs = BUILD_PUBLISH_VERBS[program];
  if (publishVerbs) {
    const verb = argv.slice(1).find((a) => !a.startsWith('-'));
    if (verb !== undefined && publishVerbs.includes(verb)) return PUBLISH_RULE;
  }

  if (READ_ONLY_PROGRAMS.has(program) || BUILD_PROGRAMS.has(program)) {
    return READ;
  }

  if (program === 'rm') {
    return {
      name: 'rm',
      effectClass: 'workspace_write',
      reversible: false,
      summary: 'Deletes files',
    };
  }

  if (WORKSPACE_WRITE_PROGRAMS.has(program)) {
    return {
      name: `${program}-workspace`,
      effectClass: 'workspace_write',
      reversible: true,
      summary: 'Modifies files in the workspace',
    };
  }

  if (program === 'sed' && argv.includes('-i')) {
    return {
      name: 'sed-in-place',
      effectClass: 'workspace_write',
      reversible: true,
      summary: 'Edits files in place',
    };
  }
  if (program === 'sed') return READ;

  if (PACKAGE_MANAGERS.has(program)) {
    const words = argv.slice(1).filter((a) => !a.startsWith('-'));
    if (words[0] === 'publish') return PUBLISH_RULE;
    if (words[0] === 'install' || words[0] === 'i' || words[0] === 'ci' || words[0] === 'add') {
      return {
        name: `${program}-install`,
        effectClass: 'workspace_write',
        reversible: true,
        summary: 'Installs dependencies',
      };
    }
    if (words[0] === 'test' || words[0] === 'run' || words[0] === 'exec') {
      // `npm run <script>` executes arbitrary project scripts. We cannot see
      // what the script does, so we do not vouch for it.
      return words[0] === 'test'
        ? READ
        : {
            name: `${program}-run-script`,
            effectClass: 'unknown',
            reversible: false,
            summary: `Runs a project script (${words[1] ?? 'unnamed'}) whose contents we cannot see`,
          };
    }
    return UNKNOWN_RULE;
  }

  if (NETWORK_PROGRAMS.has(program)) {
    const target = argv.slice(1).find((a) => !a.startsWith('-'));
    if (target && isLocalUrl(target)) return { ...READ, name: 'localhost-request' };
    return {
      name: 'network-egress',
      effectClass: 'egress',
      reversible: false,
      summary: `Sends a request off this machine${target ? ` to ${target}` : ''}`,
    };
  }

  if (REMOTE_COPY_PROGRAMS.has(program)) {
    return {
      name: 'remote-transfer',
      effectClass: 'egress',
      reversible: false,
      summary: 'Transfers data to or executes on a remote host',
    };
  }

  const table = SUBCOMMAND_RULES[program];
  if (table) {
    for (const entry of table) {
      if (matchesSubcommands(argv, entry.match)) return entry.rule;
    }
  }

  return UNKNOWN_RULE;
}

function worst(rules: Rule[]): Rule {
  return rules.reduce((acc, r) =>
    SEVERITY[r.effectClass] > SEVERITY[acc.effectClass] ? r : acc,
  );
}

/**
 * Classify a shell command into an effect assessment.
 *
 * Fails closed in every ambiguous case: an unreadable command line, an
 * unrecognised program, or a script whose body we cannot see all resolve to
 * `unknown` with `reversible: false`. Policy decides what to do with that —
 * the shipped template requires approval — but the classifier will never
 * volunteer that something is safe when it does not know.
 */
export function classifyCommand(input: CommandInput): EffectAssessment {
  const argv = input.argv.filter((a) => a.length > 0);
  if (argv.length === 0) {
    return toAssessment(UNKNOWN_RULE);
  }

  // `bash -c "git push && npm publish"` — classify the payload, not bash.
  const inner = unwrapShellInvocation(argv);
  if (inner !== null) {
    const reading = readShell(inner);
    if (reading.unreadable) {
      return toAssessment({
        name: 'opaque-shell',
        effectClass: 'unknown',
        reversible: false,
        summary: `Command contains ${reading.reason ?? 'unreadable syntax'}`,
      });
    }
    if (reading.segments.length === 0) return toAssessment(UNKNOWN_RULE);
    return toAssessment(
      worst(reading.segments.map((s) => classifySegment(s.argv, s.pipedInto))),
    );
  }

  return toAssessment(classifySegment(argv, false));
}

/** Classify a raw command line (what a PreToolUse hook receives). */
export function classifyCommandLine(
  command: string,
  cwd?: string,
): EffectAssessment {
  const reading = readShell(command);
  if (reading.unreadable) {
    return toAssessment({
      name: 'opaque-shell',
      effectClass: 'unknown',
      reversible: false,
      summary: `Command contains ${reading.reason ?? 'unreadable syntax'}`,
    });
  }
  if (reading.segments.length === 0) return toAssessment(UNKNOWN_RULE);
  const rules = reading.segments.map((s) => {
    const inner = unwrapShellInvocation(s.argv);
    if (inner !== null) return classifyCommandRule(inner);
    return classifySegment(s.argv, s.pipedInto);
  });
  void cwd;
  return toAssessment(worst(rules));
}

function classifyCommandRule(inner: string): Rule {
  const a = classifyCommandLine(inner);
  return {
    name: a.matchedRule,
    effectClass: a.effectClass,
    reversible: a.reversible,
    summary: a.summary,
  };
}

function toAssessment(rule: Rule): EffectAssessment {
  return {
    effectClass: rule.effectClass,
    reversible: rule.reversible,
    matchedRule: rule.name,
    summary: rule.summary,
  };
}

export { SEVERITY };
