import type { AuditExportRow } from './audit.service.js';

export const AUDIT_EXPORT_COLUMNS = [
  'id',
  'created_at',
  'actor_type',
  'actor_id',
  'event_type',
  'tool',
  'effect',
  'approver_email',
  'error_code',
  'payload_json',
] as const;

export type AuditExportFormat = 'csv' | 'json';

export function formatAuditCsv(rows: AuditExportRow[]): string {
  return Array.from(auditCsvChunks(rows)).join('');
}

export function* auditCsvChunks(rows: AuditExportRow[]): Generator<string> {
  yield `${AUDIT_EXPORT_COLUMNS.join(',')}\r\n`;
  for (const row of rows) {
    yield `${AUDIT_EXPORT_COLUMNS.map((col) => csvCell(row, col)).join(',')}\r\n`;
  }
}

export function formatAuditJson(rows: AuditExportRow[]): string {
  return Array.from(auditJsonChunks(rows)).join('');
}

export function* auditJsonChunks(
  rows: AuditExportRow[],
  exportedAt: Date = new Date(),
): Generator<string> {
  yield `{\n  "exported_at": ${JSON.stringify(exportedAt.toISOString())},\n`;
  yield `  "count": ${rows.length},\n  "rows": [`;
  for (const [index, row] of rows.entries()) {
    const json = JSON.stringify(jsonRow(row), null, 2)
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    yield `${index === 0 ? '\n' : ',\n'}${json}`;
  }
  yield rows.length > 0 ? '\n  ]\n}\n' : ']\n}\n';
}

export function exportFilename(format: AuditExportFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  return `agentbase-audit-${stamp}.${format}`;
}

function csvCell(row: AuditExportRow, col: (typeof AUDIT_EXPORT_COLUMNS)[number]): string {
  switch (col) {
    case 'id':
      return escapeCsv(row.id);
    case 'created_at':
      return escapeCsv(row.createdAt.toISOString());
    case 'actor_type':
      return escapeCsv(row.actorType);
    case 'actor_id':
      return escapeCsv(row.actorId);
    case 'event_type':
      return escapeCsv(row.eventType);
    case 'tool':
      return escapeCsv(stringField(row.payload, 'tool'));
    case 'effect':
      return escapeCsv(
        stringField(row.payload, 'effect') ??
          stringField(payloadDecision(row.payload), 'effect') ??
          '',
      );
    case 'approver_email':
      return escapeCsv(
        stringField(row.payload, 'decided_by_email') ??
          stringField(row.payload, 'approver_email') ??
          '',
      );
    case 'error_code': {
      const errPayload = row.payload as { error?: { code?: string } };
      return escapeCsv(errPayload.error?.code ?? '');
    }
    case 'payload_json':
      return escapeCsv(JSON.stringify(row.payload));
  }
}

function jsonRow(row: AuditExportRow): Record<string, unknown> {
  return {
    id: row.id,
    org_id: row.orgId,
    created_at: row.createdAt.toISOString(),
    actor_type: row.actorType,
    actor_id: row.actorId,
    event_type: row.eventType,
    payload: row.payload,
  };
}

/**
 * The policy decision inside an audit payload, under either key it was ever
 * written with.
 *
 * `action.assessment_failed` writes `policy_decision`. `action.denied`,
 * `action.awaiting_approval`, `action.executed`, and `action.failed` write
 * `decision`. The exporter only ever read the first, so the `effect` column
 * has been blank since the export shipped — for every event a compliance
 * reviewer actually opens this file to see.
 *
 * Both keys are read rather than normalising the emitters, because historical
 * audit rows already carry `decision` and an export that cannot read the rows
 * on disk is not an export. Normalising going forward would fix new rows and
 * leave every existing one blank.
 */
function payloadDecision(payload: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['policy_decision', 'decision']) {
    const value = payload[key];
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  }
  return {};
}

function stringField(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

// RFC 4180-ish: wrap in double quotes if the field contains a comma, quote,
// or newline; double up internal quotes.
function escapeCsv(value: string | undefined | null): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  if (s === '') return '';
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
