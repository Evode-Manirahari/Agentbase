import { findBookingClaim } from './claims.js';
import { isAvailabilityTool } from './classify.js';
import type { BookingAttempt, Finding, NormalizedCall, Utterance } from './types.js';
import { CHECK_TITLES } from './types.js';

export interface CallCheckContext {
  /**
   * Whether this call's agent invoked a booking tool anywhere in the dataset.
   * An agent with no booking tool that says "you're booked" on every call is
   * one finding about the agent, not one per call. The caller of this function
   * reports that once, as a note.
   */
  agentHasBookingTool: boolean;
}

export interface CallCheckResult {
  findings: Finding[];
  /** True when a claim went unreported here because the agent has no booking tool. */
  claimWithoutBookingTool: boolean;
}

const TIME_LIKE_KEY = /date|time|start|slot|when|day/i;
// "date_of_birth" and "birthday" are time-like by name and are not a slot.
const NOT_A_SLOT_KEY = /birth|dob/i;

/**
 * The slot, for a finding's one-line detail. Only time-like arguments are
 * shown: they are the evidence a human needs and they are not personal data.
 * Who the booking is for stays in the timeline, where it is redacted.
 */
function slotHint(identity: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(identity)) {
    if (TIME_LIKE_KEY.test(k) && !NOT_A_SLOT_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      parts.push(String(v));
    }
  }
  return parts.length > 0 ? ` for ${parts.slice(0, 2).join(' ')}` : '';
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function refSignature(attempt: BookingAttempt): string {
  return [...attempt.appointmentRefs].sort().join('|');
}

// --- F1: the same booking sent more than once --------------------------------

function checkRepeated(call: NormalizedCall, attempts: BookingAttempt[]): Finding[] {
  const groups = new Map<string, BookingAttempt[]>();
  for (const a of attempts) {
    const group = groups.get(a.intentKey);
    if (group) group.push(a);
    else groups.set(a.intentKey, [a]);
  }

  const findings: Finding[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first || group.length < 2) continue;

    const confirmed = group.filter((a) => a.outcome === 'confirmed');
    const unknown = group.filter((a) => a.outcome === 'unknown');
    const failed = group.filter((a) => a.outcome === 'failed');
    const slot = slotHint(first.identity);
    const eventIndexes = group.flatMap((a) => (a.result ? [a.invocation.index, a.result.index] : [a.invocation.index]));
    const base = { check: 'F1' as const, callId: call.id, title: CHECK_TITLES.F1, quote: null, eventIndexes };

    if (confirmed.length >= 2) {
      // Compare per-attempt, not pooled: one appointment can carry two
      // references (an appointment id and an event id), and pooling them would
      // read a deduplicated repeat as two appointments.
      const signatures = new Set(confirmed.map(refSignature));
      const everyoneHasRef = confirmed.every((a) => a.appointmentRefs.length > 0);

      if (everyoneHasRef && signatures.size === 1) {
        findings.push({
          ...base,
          severity: 'low',
          detail: `The booking${slot} was sent ${group.length} times and every confirmed result carries the same appointment reference. Your backend deduplicated the repeats.`,
          whatToCheck: 'Nothing to fix here. It is listed so you can see the agent re-sent a write.',
        });
      } else if (everyoneHasRef) {
        findings.push({
          ...base,
          severity: 'high',
          detail: `The booking${slot} was sent ${group.length} times and ${confirmed.length} were confirmed, with ${signatures.size} different appointment references. The caller asked for one.`,
          whatToCheck: `Look this slot up in your booking system. Expect one appointment. References returned: ${[...new Set(confirmed.flatMap((a) => a.appointmentRefs))].join(', ')}.`,
        });
      } else {
        findings.push({
          ...base,
          severity: 'high',
          detail: `The booking${slot} was sent ${group.length} times and ${confirmed.length} were confirmed. The results do not show whether they are the same appointment.`,
          whatToCheck: 'Look this slot up in your booking system. Expect one appointment. If there are more, cancel the extras.',
        });
      }
      continue;
    }

    if (unknown.length > 0) {
      findings.push({
        ...base,
        severity: 'medium',
        detail: `The booking${slot} was sent ${group.length} times: ${confirmed.length} confirmed, ${failed.length} failed, ${unknown.length} with an unknown outcome. An unknown repeat may have created a second appointment.`,
        whatToCheck: 'Look this slot up in your booking system. Expect at most one appointment.',
      });
    } else {
      findings.push({
        ...base,
        severity: 'low',
        detail: `The booking${slot} was sent ${group.length} times: ${confirmed.length} confirmed, ${failed.length} rejected. The repeats did not get through.`,
        whatToCheck: 'Nothing to fix here. It is listed so you can see the agent re-sent a write.',
      });
    }
  }
  return findings;
}

// --- F2: a booking made with no caller turn before it ------------------------

function checkUnconfirmedExtra(call: NormalizedCall, attempts: BookingAttempt[]): Finding[] {
  if (attempts.length < 2) return [];
  const callerTurns = call.events
    .filter((e): e is Utterance => e.kind === 'utterance' && e.speaker === 'user' && e.phase === 'call')
    .map((e) => e.index);
  const callerSpokeBetween = (from: number, to: number): boolean => callerTurns.some((i) => i > from && i < to);

  // A run is a stretch of booking attempts with no caller speech between them.
  // Whatever the caller agreed to, they agreed to it before the run began.
  const runs: BookingAttempt[][] = [];
  for (const attempt of attempts) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    if (run && prev && !callerSpokeBetween(prev.invocation.index, attempt.invocation.index)) run.push(attempt);
    else runs.push([attempt]);
  }

  const findings: Finding[] = [];
  for (const run of runs) {
    const first = run[0];
    if (!first || run.length < 2) continue;

    // Two different bookings, both confirmed first time, is a caller who asked
    // for two appointments in one breath. Something has to have gone wrong in
    // the run (a failure, an unknown, a repeat) before a second slot is suspect.
    const intents = run.map((a) => a.intentKey);
    const troubled = run.some((a) => a.outcome !== 'confirmed') || new Set(intents).size < intents.length;
    if (!troubled) continue;

    const seen = new Set<string>();
    const extras = run.filter((a) => {
      if (a.outcome !== 'confirmed' || a.intentKey === first.intentKey || seen.has(a.intentKey)) return false;
      seen.add(a.intentKey);
      return true;
    });
    if (extras.length === 0) continue;

    const slots = extras.map((a) => slotHint(a.identity).replace(/^ for /, '')).filter(Boolean);
    findings.push({
      check: 'F2',
      severity: 'high',
      callId: call.id,
      title: CHECK_TITLES.F2,
      quote: null,
      detail: `${plural(extras.length, 'booking was', 'bookings were')} confirmed${slots.length > 0 ? ` (${slots.join('; ')})` : ''} right after another booking attempt, with no caller speech in between. The caller cannot have agreed to ${extras.length === 1 ? 'it' : 'them'}.`,
      whatToCheck: `Look for ${extras.length === 1 ? 'this appointment' : 'these appointments'} in your booking system and cancel what the caller did not ask for.${extras.some((a) => a.appointmentRefs.length > 0) ? ` References returned: ${extras.flatMap((a) => a.appointmentRefs).join(', ')}.` : ''}`,
      eventIndexes: extras.flatMap((a) => (a.result ? [a.invocation.index, a.result.index] : [a.invocation.index])),
    });
  }
  return findings;
}

// --- F3: "you're booked" with nothing behind it -------------------------------

function checkUnverifiedClaim(
  call: NormalizedCall,
  inCall: BookingAttempt[],
  all: BookingAttempt[],
  ctx: CallCheckContext,
): { finding: Finding | null; claimWithoutBookingTool: boolean } {
  const confirmed = all.filter((a) => a.outcome === 'confirmed' && a.result);

  const unverified: { utterance: Utterance; sentence: string }[] = [];
  for (const ev of call.events) {
    if (ev.kind !== 'utterance' || ev.speaker !== 'agent' || ev.phase !== 'call') continue;
    const sentence = findBookingClaim(ev.text);
    if (!sentence) continue;
    // The result has to be in hand BEFORE the sentence is spoken.
    const backed = confirmed.some((a) => a.result !== null && a.result.index < ev.index);
    if (!backed) unverified.push({ utterance: ev, sentence });
  }

  const first = unverified[0];
  if (!first) return { finding: null, claimWithoutBookingTool: false };

  // This agent never calls a booking tool, in this call or any other. Either
  // bookings are created after the call from the transcript, which the audit
  // cannot see, or the tool has a name we did not recognise. Both are one note
  // about the agent, not a finding on every call it took.
  if (all.length === 0 && !ctx.agentHasBookingTool) return { finding: null, claimWithoutBookingTool: true };

  const more = unverified.length > 1 ? ` ${unverified.length} such sentences in this call.` : '';
  const eventIndexes = unverified.map((u) => u.utterance.index);
  const base = {
    check: 'F3' as const,
    callId: call.id,
    title: CHECK_TITLES.F3,
    quote: first.sentence,
    eventIndexes,
  };

  const later = confirmed.find((a) => a.result !== null && a.result.index > first.utterance.index);
  if (later) {
    const when = later.invocation.phase === 'post' ? 'after the call ended' : 'later in the call';
    return {
      claimWithoutBookingTool: false,
      finding: {
        ...base,
        severity: 'low',
        detail: `The agent told the caller a booking was made before any booking result had come back. A booking was confirmed ${when}.${more}`,
        whatToCheck: 'The booking exists according to the log. The agent spoke before it knew that.',
      },
    };
  }

  const before = inCall.filter((a) => a.invocation.index < first.utterance.index);
  let state: string;
  if (before.length === 0) {
    const availabilityRan = call.events.some(
      (e) => e.kind === 'tool_invocation' && e.index < first.utterance.index && isAvailabilityTool(e),
    );
    state = availabilityRan
      ? 'Only the availability check had run. The booking tool had not been called.'
      : 'No booking tool had been called.';
  } else if (before.some((a) => a.outcome === 'unknown')) {
    state = 'The booking tool had been called and its outcome is unknown.';
  } else {
    state = 'The booking tool had been called and it failed.';
  }

  return {
    claimWithoutBookingTool: false,
    finding: {
      ...base,
      severity: 'high',
      detail: `The agent told the caller a booking was made and no confirmed booking result precedes it. ${state}${more} This is an unverified claim. It does not prove the appointment is missing.`,
      whatToCheck:
        'Look for this caller in your booking system. If the appointment is there, the log is incomplete. If it is not, the caller believes they are booked and needs a call back.',
    },
  };
}

// --- F4: nobody knows whether the booking happened ----------------------------

function checkUnknownOutcome(call: NormalizedCall, attempts: BookingAttempt[]): Finding[] {
  const groups = new Map<string, BookingAttempt[]>();
  for (const a of attempts) {
    const group = groups.get(a.intentKey);
    if (group) group.push(a);
    else groups.set(a.intentKey, [a]);
  }

  // An intent with a confirmed attempt is resolved for the caller. Its unknown
  // repeats are F1's business. What is left here is unresolved outright.
  const unresolved = [...groups.values()].filter(
    (g) => !g.some((a) => a.outcome === 'confirmed') && g.some((a) => a.outcome === 'unknown'),
  );
  if (unresolved.length === 0) return [];

  const unknowns = unresolved.flatMap((g) => g.filter((a) => a.outcome === 'unknown'));
  const firstUnknown = unknowns[0];
  const slots = unresolved.map((g) => (g[0] ? slotHint(g[0].identity).replace(/^ for /, '') : '')).filter(Boolean);
  return [
    {
      check: 'F4',
      severity: 'medium',
      callId: call.id,
      title: CHECK_TITLES.F4,
      quote: null,
      detail: `${plural(unresolved.length, 'booking has', 'bookings have')} no known outcome${slots.length > 0 ? ` (${slots.join('; ')})` : ''}. ${firstUnknown ? firstUnknown.outcomeReason : ''}`.trim(),
      whatToCheck:
        'Look this slot up in your booking system. If the appointment exists the caller is fine. If it does not, nobody told the caller.',
      eventIndexes: unknowns.flatMap((a) => (a.result ? [a.invocation.index, a.result.index] : [a.invocation.index])),
    },
  ];
}

export function checkCall(call: NormalizedCall, attempts: BookingAttempt[], ctx: CallCheckContext): CallCheckResult {
  // Bookings made by post-call automation count as evidence for a claim (F3)
  // and are otherwise out of scope: nobody was on the line to hear about them.
  const inCall = attempts.filter((a) => a.invocation.phase === 'call');

  const claim = checkUnverifiedClaim(call, inCall, attempts, ctx);
  const findings = [
    ...checkRepeated(call, inCall),
    ...checkUnconfirmedExtra(call, inCall),
    ...(claim.finding ? [claim.finding] : []),
    ...checkUnknownOutcome(call, inCall),
  ];
  return { findings, claimWithoutBookingTool: claim.claimWithoutBookingTool };
}
