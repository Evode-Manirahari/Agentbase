import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  AUDIT_EXPORT_COLUMNS,
  auditCsvChunks,
  auditJsonChunks,
  exportFilename,
  formatAuditCsv,
  formatAuditJson,
} from './audit-export.js';
import type { AuditExportRow } from './audit.service.js';

function row(overrides: Partial<AuditExportRow> = {}): AuditExportRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    orgId: '22222222-2222-2222-2222-222222222222',
    actorType: 'agent',
    actorId: 'agent-1',
    eventType: 'action.executed',
    payload: { tool: 'hubspot.contacts.update' },
    createdAt: new Date('2026-05-18T13:00:00.000Z'),
    ...overrides,
  };
}

describe('formatAuditCsv', () => {
  it('emits a header row followed by one row per event with CRLF newlines', () => {
    const csv = formatAuditCsv([
      row({ id: 'a', actorId: 'agent-1' }),
      row({ id: 'b', actorId: 'agent-2' }),
    ]);
    const lines = csv.split('\r\n');
    assert.equal(lines[0], AUDIT_EXPORT_COLUMNS.join(','));
    assert.equal(lines.length, 4, 'header + 2 rows + trailing empty');
    assert.match(lines[1]!, /^a,/);
    assert.match(lines[2]!, /^b,/);
  });

  it('escapes cells containing commas, quotes, and newlines per RFC 4180', () => {
    const csv = formatAuditCsv([
      row({
        payload: {
          tool: 'gmail.send',
          decided_by_email: 'sec, ops "lead"',
        },
      }),
    ]);
    const dataLine = csv.split('\r\n')[1]!;
    assert.ok(
      dataLine.includes('"sec, ops ""lead"""'),
      `expected quoted+escaped approver_email, got: ${dataLine}`,
    );
  });

  it('pulls effect from payload.effect or payload.policy_decision.effect', () => {
    const direct = formatAuditCsv([
      row({ payload: { tool: 'gmail.send', effect: 'require_approval' } }),
    ]);
    const nested = formatAuditCsv([
      row({
        payload: {
          tool: 'gmail.send',
          policy_decision: { effect: 'allow' },
        },
      }),
    ]);
    assert.ok(direct.includes('require_approval'), 'direct payload.effect');
    assert.ok(nested.includes('allow'), 'nested policy_decision.effect');
  });

  it('emits empty string for missing payload fields without breaking column alignment', () => {
    const csv = formatAuditCsv([row({ payload: {} })]);
    const dataLine = csv.split('\r\n')[1]!;
    const cells = dataLine.split(',');
    assert.equal(cells.length, AUDIT_EXPORT_COLUMNS.length);
  });

  it('includes the raw JSON payload as the last column for grep-and-dig', () => {
    const payload = { tool: 'gmail.send', extra: { nested: ['x', 'y'] } };
    const csv = formatAuditCsv([row({ payload })]);
    assert.ok(csv.includes(JSON.stringify(payload).replace(/"/g, '""')));
  });

  it('neutralizes spreadsheet formula prefixes in scalar cells', () => {
    const csv = formatAuditCsv([
      row({
        actorId: '=cmd',
        payload: {
          tool: '+SUM(1,1)',
          effect: '-10',
          decided_by_email: '@ops.example',
          error: { code: '=ERR' },
        },
      }),
    ]);
    const dataLine = csv.split('\r\n')[1]!;
    assert.ok(dataLine.includes("'=cmd"));
    assert.ok(dataLine.includes("\"'+SUM(1,1)\""));
    assert.ok(dataLine.includes("'-10"));
    assert.ok(dataLine.includes("'@ops.example"));
    assert.ok(dataLine.includes("'=ERR"));
  });

  it('can emit CSV one row chunk at a time', () => {
    const chunks = Array.from(auditCsvChunks([row({ id: 'a' }), row({ id: 'b' })]));
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0], `${AUDIT_EXPORT_COLUMNS.join(',')}\r\n`);
    assert.match(chunks[1]!, /^a,/);
    assert.match(chunks[2]!, /^b,/);
  });
});

describe('formatAuditJson', () => {
  it('returns a JSON envelope with count and rows', () => {
    const json = JSON.parse(formatAuditJson([row(), row({ id: 'second' })]));
    assert.equal(json.count, 2);
    assert.equal(json.rows.length, 2);
    assert.equal(json.rows[0].event_type, 'action.executed');
    assert.match(json.rows[0].created_at, /^2026-05-18T13:00:00\.000Z$/);
    assert.match(json.exported_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves the raw payload shape for downstream parsers', () => {
    const payload = { tool: 'gmail.send', policy_decision: { effect: 'allow' } };
    const json = JSON.parse(formatAuditJson([row({ payload })]));
    assert.deepEqual(json.rows[0].payload, payload);
  });

  it('can emit JSON in parseable chunks', () => {
    const chunks = Array.from(
      auditJsonChunks([row(), row({ id: 'second' })], new Date('2026-05-18T13:14:15.678Z')),
    );
    const json = JSON.parse(chunks.join(''));
    assert.equal(chunks.length, 5);
    assert.equal(json.exported_at, '2026-05-18T13:14:15.678Z');
    assert.equal(json.count, 2);
    assert.equal(json.rows[1].id, 'second');
  });
});

describe('exportFilename', () => {
  it('produces filesystem-safe filenames with the requested extension', () => {
    const now = new Date('2026-05-18T13:14:15.678Z');
    assert.equal(exportFilename('csv', now), 'agentbase-audit-2026-05-18T13-14-15Z.csv');
    assert.equal(exportFilename('json', now), 'agentbase-audit-2026-05-18T13-14-15Z.json');
  });
});

// The `effect` column was blank from the day the export shipped. The exporter
// read `payload.policy_decision`; the events a reviewer actually opens this
// file for — denied, awaiting_approval, executed, failed — write the key as
// `decision`. Nobody noticed because an empty CSV cell looks like "no policy
// applied" rather than like a bug.
describe('audit export — the effect column', () => {
  function effectColumn(payload: Record<string, unknown>): string {
    const rows = [
      {
        createdAt: new Date('2026-08-05T18:00:00Z'),
        actorType: 'agent',
        actorId: 'a1',
        eventType: 'action.denied',
        payload,
      },
    ];
    let out = '';
    for (const chunk of auditCsvChunks(rows as never)) out += chunk;
    const line = out.trim().split('\n')[1] ?? '';
    return line.split(',')[6] ?? '';
  }

  it('reads the `decision` key the action events actually write', () => {
    assert.equal(
      effectColumn({ tool: 't.t', decision: { effect: 'require_approval' } }),
      'require_approval',
    );
  });

  it('still reads the `policy_decision` key', () => {
    assert.equal(
      effectColumn({ tool: 't.t', policy_decision: { effect: 'deny' } }),
      'deny',
    );
  });

  it('is not confused by the effect ASSESSMENT sharing the name', () => {
    // payload.effect is an object (effectClass/reversible/summary), while this
    // column wants the policy effect. They collide by name and not by meaning.
    assert.equal(
      effectColumn({
        tool: 'shell.run',
        decision: { effect: 'allow' },
        effect: { effectClass: 'publish', reversible: false, summary: 'x' },
      }),
      'allow',
    );
  });

  it('is empty when there genuinely was no decision', () => {
    assert.equal(effectColumn({ tool: 't.t' }), '');
  });
});
