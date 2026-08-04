// What kind of consequence an action has. The classifier reports these as
// FACTS about a command; policy decides what to do about them. Keeping the two
// separate is deliberate: a customer can retune policy without us shipping a
// new classifier, and we can improve classification without silently changing
// anyone's permissions.
export type EffectClass =
  // Reads nothing outside the workspace and changes nothing. `ls`, `cat`,
  // `git status`, a test run.
  | 'read'
  // Changes the local workspace only. Recoverable from git or a fresh clone.
  | 'workspace_write'
  // Moves code somewhere other people or systems will see it.
  | 'vcs_write'
  // Changes what is running in an environment.
  | 'deploy'
  // Publishes an artifact to a registry the world can install from.
  | 'publish'
  // Changes or destroys persistent data or infrastructure.
  | 'infra_write'
  // Leaves the machine over the network to a destination we can't vouch for.
  | 'egress'
  // Moves money or sends a message to a human.
  | 'external_comms'
  // We could not confidently classify it. Never silently treated as safe.
  | 'unknown';

export interface EffectAssessment {
  effectClass: EffectClass;
  // Can the workspace/world be put back the way it was without asking anyone?
  // `git commit` is reversible; `npm publish` is not.
  reversible: boolean;
  // Which rule fired, for the audit trail and for the approval card. Humans
  // approving an action need to know why it was flagged.
  matchedRule: string;
  // Short, human-readable, shown on the Slack card.
  summary: string;
}

export interface CommandInput {
  // Full argv as the agent intends to run it, already split. argv[0] is the
  // program. We never re-parse a shell string ourselves — see parseShell().
  argv: string[];
  cwd?: string | undefined;
}
