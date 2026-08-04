import type {
  AgentPermissionProfile,
  Condition,
  ConditionOperator,
  PolicyDocument,
  PolicyDecision,
  PolicyRule,
} from '@agentbase/shared';

export interface ActionContext {
  tool: string;
  params: Record<string, unknown>;
  agent?: {
    id: string;
    name: string;
    permission_profile: AgentPermissionProfile;
  } | null;
}

export interface EvaluateOptions {
  policyId?: string | null;
  isFallback?: boolean;
}

export function evaluatePolicy(
  doc: PolicyDocument,
  action: ActionContext,
  opts: EvaluateOptions = {},
): PolicyDecision {
  for (let i = 0; i < doc.rules.length; i++) {
    const rule = doc.rules[i]!;
    if (ruleMatches(rule, action)) {
      return {
        effect: rule.effect,
        reason: rule.reason ?? `matched rule[${i}]: ${rule.match.tool}`,
        rule_index: i,
        rule_matched: rule,
        approver_role: rule.approver_role ?? null,
        policy_id: opts.policyId ?? null,
        fallback: opts.isFallback ?? false,
      };
    }
  }
  return {
    effect: doc.default,
    reason: `no rule matched; default=${doc.default}`,
    rule_index: null,
    rule_matched: null,
    approver_role: null,
    policy_id: opts.policyId ?? null,
    fallback: opts.isFallback ?? false,
  };
}

function ruleMatches(rule: PolicyRule, action: ActionContext): boolean {
  if (!matchesToolPattern(rule.match.tool, action.tool)) return false;
  if (rule.match.agent_id && action.agent?.id !== rule.match.agent_id) return false;
  if (rule.match.agent_name && action.agent?.name !== rule.match.agent_name) return false;
  if (
    rule.match.agent_profile &&
    action.agent?.permission_profile !== rule.match.agent_profile
  ) {
    return false;
  }
  const when = rule.match.when;
  if (!when) return true;
  for (const [path, cond] of Object.entries(when)) {
    const value = getByPath(action.params, path);
    if (!matchCondition(value, cond)) return false;
  }
  return true;
}

export function matchesToolPattern(pattern: string, tool: string): boolean {
  if (!pattern.includes('*')) return pattern === tool;
  const regex = new RegExp(
    '^' + pattern.split('*').map(escapeRegex).join('.*') + '$',
  );
  return regex.test(tool);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getByPath(obj: unknown, path: string): unknown {
  if (path === '') return obj;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function matchCondition(value: unknown, cond: Condition): boolean {
  if (cond === null) return value === null;
  const t = typeof cond;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return value === cond;
  }
  return matchOperator(value, cond as ConditionOperator);
}

function matchOperator(value: unknown, op: ConditionOperator): boolean {
  if ('eq' in op) return deepEqual(value, op.eq);
  if ('neq' in op) return !deepEqual(value, op.neq);
  if ('gt' in op) return typeof value === 'number' && value > op.gt;
  if ('gte' in op) return typeof value === 'number' && value >= op.gte;
  if ('lt' in op) return typeof value === 'number' && value < op.lt;
  if ('lte' in op) return typeof value === 'number' && value <= op.lte;
  if ('in' in op) return op.in.some((v) => deepEqual(v, value));
  if ('contains' in op) {
    if (typeof value === 'string') return value.includes(String(op.contains));
    if (Array.isArray(value)) return value.some((v) => deepEqual(v, op.contains));
    return false;
  }
  if ('exists' in op) return op.exists ? value !== undefined : value === undefined;
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (ak.length !== bk.length) return false;
    if (!ak.every((k, i) => k === bk[i])) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

// Applied when an org has no active policy. Fails closed: a control plane
// whose default is `allow` is not a control plane, and "we hadn't written a
// policy yet" is exactly when an agent is most likely to do something nobody
// intended.
//
// This is a deliberate breaking change from the pre-1.0 behaviour. An org that
// wants the old permissive default must opt in explicitly via
// AGENTBASE_FALLBACK_POLICY=allow, which logs a warning at boot — the same
// fail-closed-with-an-explicit-escape-hatch shape as
// AGENTBASE_ALLOW_UNAUTHENTICATED.
export const FALLBACK_POLICY: PolicyDocument = {
  version: 1,
  default: 'deny',
  rules: [],
};

export const LEGACY_ALLOW_FALLBACK_POLICY: PolicyDocument = {
  version: 1,
  default: 'allow',
  rules: [],
};

export function resolveFallbackPolicy(
  env: Record<string, string | undefined> = process.env,
): PolicyDocument {
  return env['AGENTBASE_FALLBACK_POLICY'] === 'allow'
    ? LEGACY_ALLOW_FALLBACK_POLICY
    : FALLBACK_POLICY;
}
