// Library entry point. The CLI in cli.ts is a thin shell over these.
export { hasActionableFindings, runAudit } from './audit.js';
export type { AuditResult, AuditTotals, CallReport, ToolStat } from './audit.js';
export { checkCall } from './checks.js';
export { findBookingClaim } from './claims.js';
export { buildAttempts, classifyOutcome, identityOf, intentKeyOf, isAvailabilityTool, isBookingTool } from './classify.js';
export type { DetectOptions } from './classify.js';
export { loadCallsFromPath } from './load.js';
export { extractRawCalls, normalizeRetellCall, parseToolArguments } from './normalize-retell.js';
export { mask, redactMaybeJson, redactText, redactValue } from './redact.js';
export { renderHtml } from './report-html.js';
export { buildFindingsJson, renderSummary, shareSummaryLine } from './report-text.js';
export type { RunMeta } from './report-text.js';
export { fetchCalls, listEndedCallIds, retellClientOptions, RetellError } from './retell-client.js';
export { sampleCalls } from './samples.js';
export type { RetellClientOptions } from './retell-client.js';
export type {
  BookingAttempt,
  CallEvent,
  CheckId,
  Finding,
  NormalizedCall,
  Outcome,
  Severity,
  ToolInvocation,
  ToolResult,
  Utterance,
} from './types.js';
export { VERSION } from './version.js';
