// The platform-neutral model every check runs on. A platform adapter (Retell
// today) turns its own call object into this; the checks never see a platform
// field name. Adding a platform means adding an adapter, not touching a check.

export type Platform = 'retell';

/** Where in the call's lifecycle an event happened. */
export type Phase = 'pre' | 'call' | 'post';

export interface Utterance {
  kind: 'utterance';
  /** Position in the call. The ONLY ordering we have: tool events carry no clock. */
  index: number;
  speaker: 'agent' | 'user' | 'other';
  text: string;
  phase: Phase;
}

export interface ToolInvocation {
  kind: 'tool_invocation';
  index: number;
  toolCallId: string;
  name: string;
  toolType: string | null;
  rawArguments: string;
  /** Null when the arguments were not a JSON object. Never guessed. */
  args: Record<string, unknown> | null;
  phase: Phase;
}

export interface ToolResult {
  kind: 'tool_result';
  index: number;
  toolCallId: string;
  content: string;
  /** Null when the platform did not say. Absent is not the same as false. */
  successful: boolean | null;
  phase: Phase;
}

export interface OtherEvent {
  kind: 'other';
  index: number;
  label: string;
  phase: Phase;
}

export type CallEvent = Utterance | ToolInvocation | ToolResult | OtherEvent;

export interface NormalizedCall {
  id: string;
  platform: Platform;
  agentId: string | null;
  agentName: string | null;
  agentVersion: number | null;
  startedAt: number | null;
  endedAt: number | null;
  direction: string | null;
  status: string | null;
  /** True when the platform's own PII-scrubbed transcript was used. */
  scrubbed: boolean;
  hasTranscript: boolean;
  events: CallEvent[];
}

/**
 * What we can say about one booking attempt from the call log alone.
 *
 * `unknown` is a first-class answer, not a fallback. A timeout, a 5xx, a
 * missing result, or a bare "workflow was started" does not tell us whether the
 * appointment exists, and this tool does not pretend otherwise.
 */
export type Outcome = 'confirmed' | 'failed' | 'unknown';

export interface BookingAttempt {
  invocation: ToolInvocation;
  result: ToolResult | null;
  /** Same key means same booking intent: same tool, same who, same when. */
  intentKey: string;
  /** The arguments that formed the key, for display. */
  identity: Record<string, unknown>;
  outcome: Outcome;
  /** One sentence a human can check against the timeline. */
  outcomeReason: string;
  appointmentRefs: string[];
}

export type CheckId = 'F1' | 'F2' | 'F3' | 'F4';
export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  check: CheckId;
  severity: Severity;
  callId: string;
  title: string;
  /**
   * Built only from tool names, slot times and appointment references, so it is
   * safe to print as-is. Anything a person said goes in `quote`, which the
   * renderers redact.
   */
  detail: string;
  /** The sentence from the transcript this finding rests on, if any. Unredacted here. */
  quote: string | null;
  /** What to look at in the booking system. The audit cannot look for you. */
  whatToCheck: string;
  /** Timeline rows that are the evidence. */
  eventIndexes: number[];
}

export const CHECK_TITLES: Record<CheckId, string> = {
  F1: 'Repeated booking',
  F2: 'Booking the caller never confirmed',
  F3: 'Unverified booking claim',
  F4: 'Unknown booking outcome',
};

export const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
