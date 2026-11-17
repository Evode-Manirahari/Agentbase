import { canonicalize, sha256Hex } from './canonical.js';
import type { BookingAttempt, NormalizedCall, Outcome, ToolInvocation, ToolResult } from './types.js';

export interface DetectOptions {
  /** Exact tool names to treat as booking tools. Null means auto-detect. */
  bookingTools: string[] | null;
  /** Top-level argument names that define a booking intent. Null means the default rule. */
  identityKeys: string[] | null;
}

// --- Which tools create bookings --------------------------------------------

/** `Book_Appointment`, `bookAppointment`, `book-appointment` all become [book, appointment]. */
function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

const BOOKING_PREFIXES = ['book', 'schedul', 'appoint', 'reserv'];
// Tokens, not substrings: "book_specialist_appointment" contains "list" and is
// still a booking tool. A substring match would have excluded it.
const NON_BOOKING_EXACT = new Set([
  'check', 'list', 'get', 'find', 'search', 'lookup', 'look', 'update', 'modify',
  'edit', 'delete', 'remove', 'fetch', 'read', 'view', 'status',
]);
const NON_BOOKING_PREFIXES = ['avail', 'resched', 'cancel'];

/** Platform built-ins that can never create a booking, whatever they are named. */
const BUILTIN_NON_BOOKING = new Set([
  'end_call', 'transfer_call', 'bridge_transfer', 'cancel_transfer', 'agent_swap',
  'press_digit', 'send_sms', 'extract_dynamic_variable', 'adjust_voice_speed',
  'check_availability_cal',
]);

export function isBookingTool(inv: ToolInvocation, opts: DetectOptions): boolean {
  if (opts.bookingTools) {
    const wanted = inv.name.toLowerCase();
    return opts.bookingTools.some((n) => n.toLowerCase() === wanted);
  }
  if (inv.toolType === 'book_appointment_cal') return true;
  if (inv.toolType && BUILTIN_NON_BOOKING.has(inv.toolType)) return false;
  const tokens = nameTokens(inv.name);
  const looksLikeBooking = tokens.some((t) => BOOKING_PREFIXES.some((p) => t.startsWith(p)));
  if (!looksLikeBooking) return false;
  const looksLikeSomethingElse = tokens.some(
    (t) => NON_BOOKING_EXACT.has(t) || NON_BOOKING_PREFIXES.some((p) => t.startsWith(p)),
  );
  return !looksLikeSomethingElse;
}

export function isAvailabilityTool(inv: ToolInvocation): boolean {
  if (inv.toolType === 'check_availability_cal') return true;
  const tokens = nameTokens(inv.name);
  return tokens.some((t) => t.startsWith('avail') || t === 'slots' || t === 'openings');
}

// --- Booking intent ----------------------------------------------------------

// Free text the model rewrites between two calls for the same booking. Leaving
// it in the key would make a duplicate look like a different booking.
const NON_IDENTITY_KEY = /note|comment|reason|summary|description|message/i;

function normalizeIdentityValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const s = value.trim().replace(/\s+/g, ' ').toLowerCase();
    const digits = s.replace(/\D/g, '');
    // "+1 (415) 555-0123" and "4155550123" are the same caller.
    if (digits.length >= 7 && /^[+()\d\s.-]+$/.test(s)) return digits;
    return s;
  }
  if (Array.isArray(value)) return value.map(normalizeIdentityValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeIdentityValue(v);
    return out;
  }
  return value;
}

export function identityOf(inv: ToolInvocation, identityKeys: string[] | null): Record<string, unknown> {
  // Arguments we could not parse still identify a request: byte-identical raw
  // strings are the same intent. We just cannot look inside them.
  if (!inv.args) return { __raw: inv.rawArguments.trim() };

  if (identityKeys) {
    const wanted = new Set(identityKeys.map((k) => k.toLowerCase()));
    const picked: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inv.args)) if (wanted.has(k.toLowerCase())) picked[k] = v;
    // None of the requested keys exist on this tool. An empty identity would
    // make every call to it "the same booking", so fall back to the default.
    if (Object.keys(picked).length > 0) return picked;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inv.args)) if (!NON_IDENTITY_KEY.test(k)) out[k] = v;
  return out;
}

export function intentKeyOf(inv: ToolInvocation, identity: Record<string, unknown>): string {
  return sha256Hex(`${inv.name.toLowerCase()}\u0000${canonicalize(normalizeIdentityValue(identity))}`);
}

// --- Outcome of one attempt --------------------------------------------------
//
// The rule, borrowed from the commit protocol: never upgrade an unknown to a
// known. A timeout or a 5xx may have landed after the write. A bare
// acknowledgement ("Workflow was started") says the request arrived, not that
// an appointment exists. Only an explicit rejection is a `failed`.

interface Signals {
  failure: string | null;
  unknown: string | null;
  asyncAck: string | null;
  success: string | null;
  refs: string[];
}

const UNKNOWN_TEXT =
  /\b(?:time[d]?[\s-]?out|timeout|bad gateway|service unavailable|internal server error|econnreset|econnrefused|etimedout|socket hang up|network error|aborted|no response)\b|\b(?:status|code|http|error)\D{0,12}5\d\d\b/i;
const ASYNC_ACK_TEXT =
  /\bworkflow (?:was|got|has been) started\b|\brequest (?:was |has been )?(?:received|accepted|queued)\b|\b(?:queued|processing|in progress|pending|will be processed)\b/i;
const FAILURE_TEXT =
  /\b(?:not|never)\s+(?:been\s+)?(?:booked|confirmed|scheduled|created|reserved)\b|n't\s+(?:been\s+)?(?:booked|confirmed|scheduled|created|reserved|book|schedule|reserve|create)\b|\b(?:not available|unavailable|no longer available|already (?:booked|taken|reserved)|slot (?:is )?(?:taken|full)|conflict|invalid|missing required|bad request|unauthori[sz]ed|forbidden|not found|rejected|declined|cannot|can't|could not|couldn't|unable to|failed|failure|error)\b|\b(?:status|code|http)\D{0,12}4\d\d\b/i;
const SUCCESS_TEXT = /\b(?:booked|confirmed|scheduled|created|reserved|successfully|success|successful)\b/i;
const TEXT_REF =
  /\b(?:confirmation|booking|appointment|reservation)\s*(?:number|no\.?|code|id|ref(?:erence)?|#)\s*(?:is|:|#|=)?\s*([A-Za-z0-9][A-Za-z0-9-]*)/i;

const REF_KEY = /^(?:appointment|appt|booking|event|confirmation|reservation|meeting)[_-]?(?:id|uid|number|no|ref|reference|code)$/i;
const BOOL_KEYS = new Set(['success', 'ok', 'booked', 'confirmed', 'created', 'scheduled']);
const ERROR_KEYS = new Set(['error', 'errors', 'err']);
const STATUS_KEYS = new Set(['status', 'state', 'result', 'outcome']);
const TEXT_KEYS = new Set([
  'message', 'msg', 'detail', 'details', 'text', 'output', 'response', 'description', 'info', 'reason', 'title',
]);
const CODE_KEYS = new Set(['status', 'statuscode', 'status_code', 'code', 'httpstatus', 'http_status']);
const FAIL_STATUS = new Set([
  'error', 'failed', 'failure', 'rejected', 'declined', 'unavailable', 'conflict', 'invalid', 'denied',
  'cancelled', 'canceled',
]);
const UNKNOWN_STATUS = new Set(['timeout', 'timed_out', 'timedout', 'unknown']);
const ASYNC_STATUS = new Set([
  'pending', 'queued', 'processing', 'accepted', 'started', 'in_progress', 'received', 'running',
]);
const SUCCESS_STATUS = new Set([
  'confirmed', 'booked', 'success', 'successful', 'scheduled', 'created', 'ok', 'completed', 'complete',
  'done', 'reserved',
]);

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

function pushRef(sig: Signals, ref: string): void {
  if (sig.refs.length < 5 && !sig.refs.includes(ref)) sig.refs.push(ref);
}

/** One piece of free text gets one category, by priority: unknown, ack, failure, success. */
function addText(sig: Signals, text: string): void {
  const t = text.slice(0, 2000);
  if (UNKNOWN_TEXT.test(t)) sig.unknown ??= snippet(t);
  else if (ASYNC_ACK_TEXT.test(t)) sig.asyncAck ??= snippet(t);
  else if (FAILURE_TEXT.test(t)) sig.failure ??= snippet(t);
  else if (SUCCESS_TEXT.test(t)) sig.success ??= snippet(t);
  const ref = TEXT_REF.exec(t)?.[1];
  // "appointment number is not available" would otherwise yield the ref "not".
  if (ref && /\d/.test(ref)) pushRef(sig, ref);
}

function errorText(value: unknown): string | null {
  if (value === null || value === undefined || value === false || value === '') return null;
  if (value === true) return 'true';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length === 0 ? null : JSON.stringify(value);
  if (typeof value === 'object') return Object.keys(value).length === 0 ? null : JSON.stringify(value);
  return String(value);
}

function walk(value: unknown, depth: number, sig: Signals): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) walk(item, depth + 1, sig);
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const k = key.toLowerCase();

    if ((typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '') {
      // A bare `id` deep in the payload is as likely to be an attendee as an
      // appointment, so it only counts near the top.
      if (REF_KEY.test(key) || ((k === 'id' || k === 'uid') && depth <= 1)) pushRef(sig, String(v).trim());
    }

    if (typeof v === 'boolean' && BOOL_KEYS.has(k)) {
      if (v) sig.success ??= `${key}: true`;
      else sig.failure ??= `${key}: false`;
      continue;
    }
    if (ERROR_KEYS.has(k)) {
      const text = errorText(v);
      if (text) {
        if (UNKNOWN_TEXT.test(text)) sig.unknown ??= `${key}: ${snippet(text)}`;
        else sig.failure ??= `${key}: ${snippet(text)}`;
      }
      continue;
    }
    if (typeof v === 'number' && CODE_KEYS.has(k)) {
      if (v >= 500 && v <= 599) sig.unknown ??= `${key}: ${v}`;
      else if (v >= 400 && v <= 499) sig.failure ??= `${key}: ${v}`;
      continue;
    }
    if (typeof v === 'string' && STATUS_KEYS.has(k)) {
      const s = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (FAIL_STATUS.has(s)) sig.failure ??= `${key}: ${snippet(v)}`;
      else if (UNKNOWN_STATUS.has(s)) sig.unknown ??= `${key}: ${snippet(v)}`;
      else if (ASYNC_STATUS.has(s)) sig.asyncAck ??= `${key}: ${snippet(v)}`;
      else if (SUCCESS_STATUS.has(s)) sig.success ??= `${key}: ${snippet(v)}`;
      else addText(sig, v);
      continue;
    }
    if (typeof v === 'string' && TEXT_KEYS.has(k)) {
      addText(sig, v);
      continue;
    }
    if (v !== null && typeof v === 'object') walk(v, depth + 1, sig);
  }
}

function inspect(content: string): Signals {
  const sig: Signals = { failure: null, unknown: null, asyncAck: null, success: null, refs: [] };
  const trimmed = content.trim();
  if (trimmed === '') return sig;

  let parsed: unknown;
  let isJson = false;
  try {
    parsed = JSON.parse(trimmed);
    isJson = true;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        // A JSON-encoded sentence. Treated as text below.
      }
    }
  } catch {
    // Not JSON. Treated as text below.
  }

  if (!isJson) addText(sig, trimmed);
  else if (typeof parsed === 'string') addText(sig, parsed);
  else if (typeof parsed === 'boolean') {
    if (parsed) sig.success = 'true';
    else sig.failure = 'false';
  } else if (parsed !== null && typeof parsed === 'object') walk(parsed, 0, sig);
  return sig;
}

export function classifyOutcome(result: ToolResult | null): { outcome: Outcome; reason: string; refs: string[] } {
  if (!result) {
    return { outcome: 'unknown', reason: 'No result was recorded for this tool call.', refs: [] };
  }
  const sig = inspect(result.content);

  if (sig.unknown) {
    return {
      outcome: 'unknown',
      reason: `The result is a timeout or server error (${sig.unknown}). That does not show whether the booking was made.`,
      refs: sig.refs,
    };
  }
  if (sig.failure) {
    return { outcome: 'failed', reason: `The result says the booking was not made (${sig.failure}).`, refs: sig.refs };
  }
  if (result.successful === false) {
    return {
      outcome: 'unknown',
      reason:
        'The platform marked the tool call unsuccessful and the result does not say why. The booking may or may not exist.',
      refs: sig.refs,
    };
  }
  if (sig.asyncAck && sig.refs.length === 0) {
    return {
      outcome: 'unknown',
      reason: `The tool only acknowledged the request (${sig.asyncAck}). The result does not show a booking.`,
      refs: [],
    };
  }
  if (sig.refs.length > 0) {
    return {
      outcome: 'confirmed',
      reason: `The result carries an appointment reference (${sig.refs[0]}).`,
      refs: sig.refs,
    };
  }
  if (sig.success) {
    return {
      outcome: 'confirmed',
      reason: `The result says the booking succeeded (${sig.success}). It carries no appointment reference.`,
      refs: [],
    };
  }
  if (result.successful === true) {
    return {
      outcome: 'confirmed',
      reason: 'The platform marked the tool call successful. The result carries no appointment reference.',
      refs: [],
    };
  }
  return { outcome: 'unknown', reason: 'The result does not show whether the booking was made.', refs: [] };
}

// --- Attempts in one call ----------------------------------------------------

export function buildAttempts(call: NormalizedCall, opts: DetectOptions): BookingAttempt[] {
  const results = new Map<string, ToolResult>();
  for (const ev of call.events) {
    if (ev.kind === 'tool_result' && !results.has(ev.toolCallId)) results.set(ev.toolCallId, ev);
  }

  const attempts: BookingAttempt[] = [];
  const seenToolCallIds = new Set<string>();
  for (const ev of call.events) {
    if (ev.kind !== 'tool_invocation' || !isBookingTool(ev, opts)) continue;
    // A log that repeats one tool_call_id shows one request twice, not two requests.
    if (seenToolCallIds.has(ev.toolCallId)) continue;
    seenToolCallIds.add(ev.toolCallId);

    const result = results.get(ev.toolCallId) ?? null;
    const identity = identityOf(ev, opts.identityKeys);
    const { outcome, reason, refs } = classifyOutcome(result);
    attempts.push({
      invocation: ev,
      result,
      intentKey: intentKeyOf(ev, identity),
      identity,
      outcome,
      outcomeReason: reason,
      appointmentRefs: refs,
    });
  }
  return attempts;
}
