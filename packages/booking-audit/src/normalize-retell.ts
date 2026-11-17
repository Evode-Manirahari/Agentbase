import type { CallEvent, NormalizedCall, Phase } from './types.js';

// Retell adapter. Field names follow the Retell API reference (spec revision
// 2026-11-15): GET /v2/get-call/{call_id} returns `transcript_with_tool_calls`,
// an array whose entries are discriminated by `role`:
//
//   agent | user | transfer_target   { content, words[] }
//   tool_call_invocation             { tool_call_id, name, arguments (JSON string), type? }
//   tool_call_result                 { tool_call_id, content, successful? }
//   node_transition | dtmf | sms | injected
//
// Tool entries carry no timestamp. Their position in the array is the only
// ordering there is, so `index` is the clock everything downstream uses.
//
// The parser is deliberately tolerant: a call log is somebody else's data, and
// an entry we do not recognise is kept as an `other` row rather than dropped or
// thrown on. A whole call we cannot read returns null and is counted as skipped.

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Tool arguments arrive as a stringified JSON object. Some backends double-encode
 * it. Anything that is not an object after one unwrap is reported as null, and
 * the raw string is kept so the intent key can still be formed from it.
 */
export function parseToolArguments(raw: unknown): Record<string, unknown> | null {
  if (isRec(raw)) return raw;
  if (typeof raw !== 'string') return null;
  try {
    let parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        // A JSON string that is not itself JSON. Leave it; it is not an object.
      }
    }
    return isRec(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pickArray(raw: Rec, scrubbedKey: string, plainKey: string): { entries: unknown[]; scrubbed: boolean } {
  const scrubbed = raw[scrubbedKey];
  if (Array.isArray(scrubbed) && scrubbed.length > 0) return { entries: scrubbed, scrubbed: true };
  const plain = raw[plainKey];
  return { entries: Array.isArray(plain) ? plain : [], scrubbed: false };
}

function toEvent(entry: unknown, index: number, phase: Phase): CallEvent | null {
  if (!isRec(entry)) return null;
  const role = str(entry['role']);
  if (!role) return null;

  if (role === 'agent' || role === 'user' || role === 'transfer_target') {
    const text = typeof entry['content'] === 'string' ? entry['content'] : '';
    return {
      kind: 'utterance',
      index,
      speaker: role === 'agent' ? 'agent' : role === 'user' ? 'user' : 'other',
      text,
      phase,
    };
  }

  if (role === 'tool_call_invocation') {
    const toolCallId = str(entry['tool_call_id']);
    const name = str(entry['name']);
    if (!toolCallId || !name) return { kind: 'other', index, label: 'tool_call_invocation (unreadable)', phase };
    const rawArgs = entry['arguments'];
    const rawArguments = typeof rawArgs === 'string' ? rawArgs : rawArgs === undefined ? '' : JSON.stringify(rawArgs);
    return {
      kind: 'tool_invocation',
      index,
      toolCallId,
      name,
      toolType: str(entry['type']),
      rawArguments,
      args: parseToolArguments(rawArgs),
      phase,
    };
  }

  if (role === 'tool_call_result') {
    const toolCallId = str(entry['tool_call_id']);
    if (!toolCallId) return { kind: 'other', index, label: 'tool_call_result (unreadable)', phase };
    const content = entry['content'];
    return {
      kind: 'tool_result',
      index,
      toolCallId,
      content: typeof content === 'string' ? content : content === undefined || content === null ? '' : JSON.stringify(content),
      // Absent stays null. Coercing it to false would invent a failure.
      successful: typeof entry['successful'] === 'boolean' ? entry['successful'] : null,
      phase,
    };
  }

  return { kind: 'other', index, label: role, phase };
}

export function normalizeRetellCall(raw: unknown): NormalizedCall | null {
  if (!isRec(raw)) return null;
  const id = str(raw['call_id']);
  if (!id) return null;

  const pre = pickArray(raw, 'scrubbed_pre_session_transcript_with_tool_calls', 'pre_session_transcript_with_tool_calls');
  const main = pickArray(raw, 'scrubbed_transcript_with_tool_calls', 'transcript_with_tool_calls');
  const post = pickArray(raw, 'scrubbed_post_session_transcript_with_tool_calls', 'post_session_transcript_with_tool_calls');

  const events: CallEvent[] = [];
  const push = (entries: unknown[], phase: Phase): void => {
    for (const entry of entries) {
      const event = toEvent(entry, events.length, phase);
      if (event) events.push(event);
    }
  };
  push(pre.entries, 'pre');
  push(main.entries, 'call');
  push(post.entries, 'post');

  return {
    id,
    platform: 'retell',
    agentId: str(raw['agent_id']),
    agentName: str(raw['agent_name']),
    agentVersion: num(raw['agent_version']),
    startedAt: num(raw['start_timestamp']),
    endedAt: num(raw['end_timestamp']),
    direction: str(raw['direction']),
    status: str(raw['call_status']),
    scrubbed: main.scrubbed,
    hasTranscript: main.entries.length > 0,
    events,
  };
}

/**
 * Accepts whatever a builder is likely to have on disk: one call object, an
 * array of them, or a list response (`{ items: [...] }` / `{ calls: [...] }`).
 */
export function extractRawCalls(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (isRec(json)) {
    if (Array.isArray(json['items'])) return json['items'];
    if (Array.isArray(json['calls'])) return json['calls'];
    if (typeof json['call_id'] === 'string') return [json];
  }
  return [];
}
