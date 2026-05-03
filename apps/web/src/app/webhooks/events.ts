// Pinned to the event types the API actually emits. Keep in sync with
// AuditService callsites in apps/api/src.
export const KNOWN_EVENTS = [
  'action.executed',
  'action.failed',
  'action.denied',
  'action.awaiting_approval',
  'action.rate_limited',
  'action.retried',
  'action.retried_rate_limited',
  'approval.posted_to_slack',
  'approval.approved',
  'approval.denied',
  'approval.expired',
  'agent.revoked',
] as const;

export type KnownEvent = (typeof KNOWN_EVENTS)[number];
