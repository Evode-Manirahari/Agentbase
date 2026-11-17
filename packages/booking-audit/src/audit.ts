import { checkCall } from './checks.js';
import { buildAttempts, isBookingTool } from './classify.js';
import type { DetectOptions } from './classify.js';
import type { BookingAttempt, CheckId, Finding, NormalizedCall, Severity } from './types.js';
import { SEVERITY_RANK } from './types.js';

export interface CallReport {
  call: NormalizedCall;
  attempts: BookingAttempt[];
  findings: Finding[];
}

export interface ToolStat {
  name: string;
  type: string | null;
  invocations: number;
  /** The arguments that formed the booking intent, so a wrong guess is visible. */
  identityKeys: string[];
}

export interface AuditTotals {
  callsScanned: number;
  callsWithoutTranscript: number;
  callsWithBookingAttempts: number;
  bookingAttempts: number;
  confirmed: number;
  failed: number;
  unknown: number;
  /** Confirmed on the tool's word alone: no appointment reference in the result. */
  confirmedWithoutReference: number;
  flaggedCalls: number;
  byCheck: Record<CheckId, Record<Severity, number>>;
}

export interface AuditResult {
  totals: AuditTotals;
  bookingTools: ToolStat[];
  /** Every other tool seen, so a missed booking tool can be spotted and named. */
  otherTools: string[];
  agentsWithoutBookingTool: { agentId: string; callsWithClaims: number }[];
  notes: string[];
  /** Calls with at least one finding, worst first. */
  flagged: CallReport[];
}

const UNKNOWN_AGENT = '(unknown agent)';

function emptyByCheck(): Record<CheckId, Record<Severity, number>> {
  return {
    F1: { high: 0, medium: 0, low: 0 },
    F2: { high: 0, medium: 0, low: 0 },
    F3: { high: 0, medium: 0, low: 0 },
    F4: { high: 0, medium: 0, low: 0 },
  };
}

/** Two highs outrank one high and a medium: count per severity, worst first. */
function weight(findings: Finding[]): number {
  return findings.reduce((sum, f) => sum + 100 ** (SEVERITY_RANK[f.severity] - 1), 0);
}

export function runAudit(calls: NormalizedCall[], opts: DetectOptions): AuditResult {
  const toolStats = new Map<string, ToolStat>();
  const otherTools = new Set<string>();
  const agentsWithBookingTool = new Set<string>();
  const perCall: { call: NormalizedCall; attempts: BookingAttempt[] }[] = [];

  // Pass one: what did each call try to book, and which agents can book at all.
  for (const call of calls) {
    const attempts = buildAttempts(call, opts);
    perCall.push({ call, attempts });
    if (attempts.length > 0) agentsWithBookingTool.add(call.agentId ?? UNKNOWN_AGENT);

    for (const ev of call.events) {
      if (ev.kind !== 'tool_invocation') continue;
      if (!isBookingTool(ev, opts)) {
        otherTools.add(ev.name);
        continue;
      }
      // Keyed by the exact name: Book_Appointment and book_appointment are two
      // tools, usually on two installs, with different arguments.
      const stat = toolStats.get(ev.name) ?? { name: ev.name, type: ev.toolType, invocations: 0, identityKeys: [] };
      stat.invocations += 1;
      toolStats.set(ev.name, stat);
    }
    for (const attempt of attempts) {
      const stat = toolStats.get(attempt.invocation.name);
      if (!stat) continue;
      for (const k of Object.keys(attempt.identity)) if (!stat.identityKeys.includes(k)) stat.identityKeys.push(k);
    }
  }

  // Pass two: the checks. F3 needs to know whether the agent can book anywhere.
  const totals: AuditTotals = {
    callsScanned: calls.length,
    callsWithoutTranscript: 0,
    callsWithBookingAttempts: 0,
    bookingAttempts: 0,
    confirmed: 0,
    failed: 0,
    unknown: 0,
    confirmedWithoutReference: 0,
    flaggedCalls: 0,
    byCheck: emptyByCheck(),
  };
  const claimsWithoutTool = new Map<string, number>();
  const flagged: CallReport[] = [];

  for (const { call, attempts } of perCall) {
    if (!call.hasTranscript) totals.callsWithoutTranscript += 1;
    if (attempts.length > 0) totals.callsWithBookingAttempts += 1;
    totals.bookingAttempts += attempts.length;
    for (const a of attempts) {
      totals[a.outcome] += 1;
      if (a.outcome === 'confirmed' && a.appointmentRefs.length === 0) totals.confirmedWithoutReference += 1;
    }

    const agentKey = call.agentId ?? UNKNOWN_AGENT;
    const { findings, claimWithoutBookingTool } = checkCall(call, attempts, {
      agentHasBookingTool: agentsWithBookingTool.has(agentKey),
    });
    if (claimWithoutBookingTool) claimsWithoutTool.set(agentKey, (claimsWithoutTool.get(agentKey) ?? 0) + 1);
    if (findings.length === 0) continue;

    for (const f of findings) totals.byCheck[f.check][f.severity] += 1;
    flagged.push({ call, attempts, findings });
  }
  totals.flaggedCalls = flagged.length;

  flagged.sort(
    (a, b) => weight(b.findings) - weight(a.findings) || (b.call.startedAt ?? 0) - (a.call.startedAt ?? 0),
  );

  const agentsWithoutBookingTool = [...claimsWithoutTool.entries()]
    .map(([agentId, callsWithClaims]) => ({ agentId, callsWithClaims }))
    .sort((a, b) => b.callsWithClaims - a.callsWithClaims);

  const notes: string[] = [];
  if (toolStats.size === 0 && calls.length > 0) {
    const seen = [...otherTools].sort();
    notes.push(
      seen.length > 0
        ? `No booking tool was detected. Tools seen: ${seen.join(', ')}. If one of them creates bookings, pass --booking-tool <name>.`
        : 'No tool calls were found in these calls, so there is nothing to audit.',
    );
  }
  for (const { agentId, callsWithClaims } of agentsWithoutBookingTool) {
    notes.push(
      `Agent ${agentId} told the caller a booking was made in ${callsWithClaims} ${callsWithClaims === 1 ? 'call' : 'calls'} and never called a booking tool. If bookings are created after the call, this audit cannot see them. If the booking tool has an unusual name, pass --booking-tool <name>.`,
    );
  }
  if (totals.confirmedWithoutReference > 0) {
    notes.push(
      `${totals.confirmedWithoutReference} of ${totals.confirmed} confirmed bookings carried no appointment reference in the tool result. The audit took the tool's word for those.`,
    );
  }
  if (totals.callsWithoutTranscript > 0) {
    notes.push(`${totals.callsWithoutTranscript} calls had no transcript with tool calls and were not checked.`);
  }
  const scrubbed = calls.filter((c) => c.scrubbed).length;
  if (scrubbed > 0) notes.push(`Used the platform's PII-scrubbed transcript for ${scrubbed} calls.`);

  return {
    totals,
    bookingTools: [...toolStats.values()].sort((a, b) => b.invocations - a.invocations),
    otherTools: [...otherTools].sort(),
    agentsWithoutBookingTool,
    notes,
    flagged,
  };
}

/** The exit-code rule: a low finding means the backend already coped. */
export function hasActionableFindings(result: AuditResult): boolean {
  return Object.values(result.totals.byCheck).some((counts) => counts.high > 0 || counts.medium > 0);
}
