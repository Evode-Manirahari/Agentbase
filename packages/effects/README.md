# @agentbase/effects

Classifies a shell command into **what it will consequentially do** — and says so
honestly when it cannot tell.

```ts
import { classifyCommandLine } from '@agentbase/effects';

classifyCommandLine('npm test && npm publish');
// {
//   effectClass: 'publish',
//   reversible: false,
//   matchedRule: 'package-publish',
//   summary: 'Publishes a package to a public registry',
// }
```

## Why this exists

An agent about to run a command is a decision point, and the decision needs a fact:
*is this recoverable?* `git commit` is. `npm publish` is not. That distinction is what
lets a gate ask for approval on the six commands that matter instead of all four
hundred — and it is what makes replaying a recorded agent run safe, because a step
marked `reversible: false` must be served from the recording rather than re-executed.

This package reports facts. **Policy decides what to do about them.** Keeping the two
separate means a customer can retune policy without a new classifier release, and the
classifier can improve without silently changing anyone's permissions.

## Effect classes

| Class | Meaning |
|---|---|
| `read` | Changes nothing. `ls`, `git status`, a test run |
| `workspace_write` | Local working tree only. Recoverable from git or a fresh clone |
| `vcs_write` | Moves code where other people or systems will see it |
| `deploy` | Changes what is running in an environment |
| `publish` | Puts an artifact in a registry the world can install from |
| `infra_write` | Changes or destroys persistent data or infrastructure |
| `egress` | Leaves the machine for a destination we cannot vouch for |
| `external_comms` | Moves money, or sends a message to a human |
| `unknown` | We could not classify it. **Never treated as safe** |

`reversible` is tracked separately from the class, because the two are independent:
`rm -rf` is only a `workspace_write` but is not reversible.

## It fails closed

Every ambiguous case resolves to `unknown` with `reversible: false`:

| Input | Why |
|---|---|
| `echo $(whoami)` | Command substitution — we cannot see what runs |
| `` echo `id` `` | Backticks, same reason |
| `eval "$CMD"` | Body unknown at classification time |
| `curl … \| sh` | Executes piped content we never saw |
| `npm run deploy` | Project scripts have arbitrary bodies |
| `some-unknown-binary` | Not in any rule table |

A command line is as consequential as its **worst** segment: `npm test && npm publish`
is a publish, not a test. `bash -c "…"` is unwrapped so the payload is classified, not
the shell.

## What it is not

**Not a security boundary.** It reads the command line an agent *intends* to run. It
does not intercept syscalls, and it will not stop a genuinely adversarial process from
doing something else. Use it to make honest decisions about cooperating agents; use OS
sandboxing for containment.

## Development

```bash
pnpm test        # 108 tests, no external services required
pnpm typecheck
```
