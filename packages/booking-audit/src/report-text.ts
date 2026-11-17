import type { AuditResult } from './audit.js';
import { redactText } from './redact.js';
import type { CheckId, Severity } from './types.js';
import { CHECK_TITLES } from './types.js';

export interface RunMeta {
  version: string;
  /** ISO timestamp. */
  generatedAt: string;
  /** Where the calls came from, in words. */
  source: string;
  /** Which calls were in scope, in words. */
  window: string;
  redacted: boolean;
}

const CHECK_ORDER: CheckId[] = ['F1', 'F2', 'F3', 'F4'];
const SEVERITIES: Severity[] = ['high', 'medium', 'low'];

function countLine(counts: Record<Severity, number>): string {
  const total = counts.high + counts.medium + counts.low;
  if (total === 0) return '0';
  const parts = SEVERITIES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return `${total}  (${parts.join(', ')})`;
}

export function renderSummary(result: AuditResult, meta: RunMeta, reportPath: string | null): string {
  const t = result.totals;
  const lines: string[] = [];
  lines.push(`booking-audit ${meta.version}  (${meta.source}, ${meta.window})`);
  lines.push('');

  if (result.bookingTools.length === 0) {
    lines.push('Booking tools detected: none');
  } else {
    lines.push('Booking tools detected:');
    for (const tool of result.bookingTools) {
      const type = tool.type ? `, ${tool.type}` : '';
      const identity = tool.identityKeys.length > 0 ? tool.identityKeys.join(', ') : '(no arguments)';
      const times = `${tool.invocations} tool ${tool.invocations === 1 ? 'call' : 'calls'}`;
      lines.push(`  ${tool.name}  (${times}${type})  same booking = same ${identity}`);
    }
  }
  lines.push('');
  lines.push(
    `Calls scanned: ${t.callsScanned}   with booking attempts: ${t.callsWithBookingAttempts}   booking attempts: ${t.bookingAttempts}`,
  );
  lines.push(`Outcomes: ${t.confirmed} confirmed, ${t.failed} failed, ${t.unknown} unknown`);
  lines.push('');

  const width = Math.max(...CHECK_ORDER.map((c) => CHECK_TITLES[c].length));
  for (const check of CHECK_ORDER) {
    lines.push(`${check}  ${CHECK_TITLES[check].padEnd(width)}  ${countLine(t.byCheck[check])}`);
  }

  if (result.notes.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const note of result.notes) lines.push(`  - ${note}`);
  }

  lines.push('');
  lines.push(
    t.flaggedCalls === 0
      ? `No findings in ${t.callsScanned} calls.`
      : `${t.flaggedCalls} of ${t.callsScanned} calls have findings.`,
  );
  if (reportPath) lines.push(`Report: ${reportPath}`);
  return lines.join('\n');
}

/**
 * One line with counts only. No call IDs, no text from any call. Printed only
 * when the user asks for it, for pasting into a thread or an issue.
 */
export function shareSummaryLine(result: AuditResult, meta: RunMeta): string {
  const t = result.totals;
  const checks = CHECK_ORDER.map((c) => {
    const n = t.byCheck[c];
    return `${c}=${n.high + n.medium + n.low}(high ${n.high})`;
  }).join(' ');
  return `booking-audit ${meta.version} | calls=${t.callsScanned} attempts=${t.bookingAttempts} confirmed=${t.confirmed} failed=${t.failed} unknown=${t.unknown} | ${checks}`;
}

export function buildFindingsJson(result: AuditResult, meta: RunMeta): Record<string, unknown> {
  return {
    tool: 'booking-audit',
    version: meta.version,
    generatedAt: meta.generatedAt,
    source: meta.source,
    window: meta.window,
    redacted: meta.redacted,
    totals: result.totals,
    bookingTools: result.bookingTools,
    otherTools: result.otherTools,
    notes: result.notes,
    calls: result.flagged.map((report) => ({
      callId: report.call.id,
      startedAt: report.call.startedAt === null ? null : new Date(report.call.startedAt).toISOString(),
      agentId: report.call.agentId,
      agentVersion: report.call.agentVersion,
      findings: report.findings.map((f) => ({
        check: f.check,
        title: f.title,
        severity: f.severity,
        detail: f.detail,
        quote: f.quote === null ? null : meta.redacted ? redactText(f.quote) : f.quote,
        whatToCheck: f.whatToCheck,
        eventIndexes: f.eventIndexes,
      })),
    })),
  };
}
