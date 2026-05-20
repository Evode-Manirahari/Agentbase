// Multi-touch outbound sequence configuration.
//
// Touch 1 is the original ai-sdr-outbound send (handled by the existing
// runtime). Touches 2 and 3 are follow-ups scheduled at fixed intervals
// from the touch-1 send. The intervals are intentionally hardcoded
// (rather than configurable per campaign) — they match the strategy
// doc's recommended 3-touch cadence. Per-campaign cadence is a future
// PR once we have a `campaigns` entity to attach the config to.
//
// Sequence stops on any inbound reply. The reply-handler agent run
// takes over; future follow-up touches scheduled in BullMQ check
// agent_emails.reply_received and skip if true.

export const SEQUENCE_MAX_TOUCHES = 3;

export const SEQUENCE_TOUCH_INTERVALS_MS: readonly number[] = [
  3 * 24 * 60 * 60 * 1000, // touch 2: +3 days from touch 1
  7 * 24 * 60 * 60 * 1000, // touch 3: +7 days from touch 1
];
