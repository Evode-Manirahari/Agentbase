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
  const lines = [AUDIT_EXPORT_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(AUDIT_EXPORT_COLUMNS.map((col) => csvCell(row, col)).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

export function formatAuditJson(rows: AuditExportRow[]): string {
  return (
    JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        count: rows.length,
        rows: rows.map((row) => ({
          id: row.id,
          org_id: row.orgId,
          created_at: row.createdAt.toISOString(),
          actor_type: row.actorType,
          actor_id: row.actorId,
          event_type: row.eventType,
          payload: row.payload,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

export function exportFilename(format: AuditExportFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  return `dejavas-audit-${stamp}.${format}`;
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

function payloadDecision(payload: Record<string, unknown>): Record<string, unknown> {
  const value = payload['policy_decision'];
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
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
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
