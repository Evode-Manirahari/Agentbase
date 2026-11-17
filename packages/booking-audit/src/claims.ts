// Did the agent tell the caller a booking was made?
//
// Deterministic on purpose. No model call means no transcript leaves the
// machine and no second API key is needed. The cost is recall: an unusual
// phrasing is missed. That trade is the right way round for an audit, because
// every flag is shown with the exact sentence and a noisy audit is one nobody
// believes.

interface ClaimPattern {
  re: RegExp;
  /**
   * "You're all set" is only a booking claim if the utterance is about a
   * booking. Patterns that name the act ("I've booked") need no such help.
   */
  needsContext: boolean;
}

const CLAIM_PATTERNS: ClaimPattern[] = [
  { re: /\byou(?:'re|’re| are)\s+(?:now\s+)?(?:all\s+)?(?:booked|scheduled)\b/i, needsContext: false },
  { re: /\byou(?:'re|’re| are)\s+(?:now\s+)?(?:all\s+)?(?:set|confirmed|good to go)\b/i, needsContext: true },
  {
    re: /\bi(?:'ve|’ve| have)\s+(?:just\s+|now\s+|gone ahead and\s+|successfully\s+)?(?:booked|scheduled|reserved)\b/i,
    needsContext: false,
  },
  {
    re: /\bi(?:'ve|’ve| have)\s+(?:just\s+|now\s+|gone ahead and\s+|successfully\s+)?(?:confirmed|set up|made)\b/i,
    needsContext: true,
  },
  {
    re: /\b(?:your|the|that)\s+(?:appointment|booking|reservation|visit|consultation|meeting|slot|table)\s+(?:is|has been|was)\s+(?:now\s+|all\s+)?(?:booked|scheduled|confirmed|reserved|set|made)\b/i,
    needsContext: false,
  },
  { re: /\b(?:i|we)\s+(?:just\s+)?(?:booked|scheduled|reserved)\s+(?:you|your|that|it|the)\b/i, needsContext: false },
  { re: /\b(?:it|that)(?:'s|’s| is| has been)\s+(?:now\s+)?(?:booked|scheduled|reserved)\b/i, needsContext: false },
  { re: /\b(?:it|that)(?:'s|’s| is| has been)\s+(?:now\s+)?confirmed\b/i, needsContext: true },
  { re: /\b(?:i|we)(?:'ve|’ve| have)\s+got(?:ten)?\s+you\s+(?:booked|scheduled)\b/i, needsContext: false },
  { re: /\b(?:i|we)(?:'ve|’ve| have)\s+got(?:ten)?\s+you\s+(?:down|in)\b/i, needsContext: true },
];

const BOOKING_CONTEXT =
  /\b(?:appointment|booking|reservation|visit|consultation|slot|table|book(?:ed|ing)?|schedul(?:e|ed|ing))\b/i;
const TIME_CONTEXT =
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:tomorrow|today|tonight)\b|\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])|\b\d{1,2}:\d{2}\b|\b(?:january|february|march|april|june|july|august|september|october|november|december)\b|\bmay\s+\d{1,2}\b|\bo['’]clock\b/i;

// "Once you're booked you'll get a text" describes the future. So does
// "let me know when you're all set". The words that give that away sit just
// before the match, inside the same sentence.
const CONDITIONAL_PREFIX =
  /\b(?:once|after|when|whenever|if|until|before|as soon as|whether|make sure|ensure|unless|in case)\b[^.!?]{0,40}$/i;

/**
 * Returns the sentence in which the agent asserts a completed booking, or null.
 * Questions and conditionals are not claims.
 */
export function findBookingClaim(text: string): string | null {
  if (!text) return null;
  const hasContext = BOOKING_CONTEXT.test(text) || TIME_CONTEXT.test(text);
  const sentences = text.split(/(?<=[.!?])\s+/);

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence === '' || sentence.endsWith('?')) continue;
    for (const { re, needsContext } of CLAIM_PATTERNS) {
      const match = re.exec(sentence);
      if (!match) continue;
      if (needsContext && !hasContext) continue;
      if (CONDITIONAL_PREFIX.test(sentence.slice(0, match.index))) continue;
      return sentence;
    }
  }
  return null;
}
