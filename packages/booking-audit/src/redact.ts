// Redaction for everything the audit writes down.
//
// A call log is other people's phone numbers, and in a dental or medical
// install it is health information. The report is the one thing a builder is
// likely to forward, so it is redacted unless they ask otherwise.
//
// What this does NOT do: remove a name somebody said out loud. Nothing here
// can tell "Tuesday" from "Teresa" in free speech. The report says so. If the
// platform's own PII scrubbing is on, the adapter reads the scrubbed transcript
// and this is the second layer rather than the only one.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_LIKE = /\+?\d[\d\s().-]{5,}\d/g;
// A date is evidence (it is the slot), and it looks like a phone number to a regex.
const DATE_LIKE = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/;

/** Arguments whose VALUE identifies a person, whatever it looks like. */
const SENSITIVE_KEY =
  /name|first|last|patient|customer|caller|client|phone|mobile|email|dob|birth|address|street|zip|postal|ssn|insurance|member/i;
/** Appointment references are evidence. Never mask them, even when they are long numbers. */
const REFERENCE_KEY = /(?:^|[_-])(?:id|uid|ref|reference|number|no|code)$|confirmation/i;

export function mask(value: string): string {
  if (value.length <= 2) return '••';
  return `${'•'.repeat(Math.min(value.length - 2, 10))}${value.slice(-2)}`;
}

export function redactText(text: string): string {
  return text
    .replace(EMAIL, (m) => mask(m))
    .replace(PHONE_LIKE, (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 7 || DATE_LIKE.test(m.trim())) return m;
      return mask(digits);
    });
}

/** Key-aware redaction of a parsed JSON value. */
export function redactValue(value: unknown, key: string | null = null): unknown {
  if (Array.isArray(value)) return value.map((v) => redactValue(v, key));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, k);
    return out;
  }
  if (key !== null && SENSITIVE_KEY.test(key)) {
    if (typeof value === 'string' || typeof value === 'number') return mask(String(value));
    return value;
  }
  if (typeof value !== 'string') return value;
  if (key !== null && REFERENCE_KEY.test(key)) return value;
  return redactText(value);
}

/** Tool arguments and tool results arrive as strings that are usually JSON. */
export function redactMaybeJson(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactValue(JSON.parse(trimmed)));
    } catch {
      // Looked like JSON and was not. Fall through to text.
    }
  }
  return redactText(content);
}
