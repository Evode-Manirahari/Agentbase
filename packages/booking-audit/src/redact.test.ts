import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mask, redactMaybeJson, redactText, redactValue } from './redact.js';

describe('redaction', () => {
  it('masks all but the last two characters', () => {
    assert.equal(mask('14155550123'), '•••••••••23');
    assert.equal(mask('ab'), '••');
    // Long values do not reveal their length.
    assert.equal(mask('x'.repeat(40) + 'yz'), `${'•'.repeat(10)}yz`);
  });

  it('masks phone numbers and emails in free text', () => {
    const out = redactText('Call me on +1 (415) 555-0123 or dana.reyes@example.com please.');
    assert.doesNotMatch(out, /555/);
    assert.doesNotMatch(out, /dana/);
    assert.match(out, /23 or/);
    assert.match(out, /please\.$/);
  });

  it('leaves dates and times alone, because the slot is the evidence', () => {
    for (const text of ['2026-07-09T09:45:00', 'on 07/09/2026 at 9:45', 'Tuesday at 9:45 AM', 'room 12']) {
      assert.equal(redactText(text), text);
    }
  });

  it('masks the value of any argument whose name identifies a person', () => {
    const out = redactValue({
      PatientId: 1182,
      patient_name: 'Dana Reyes',
      phone: '4155550123',
      AppointmentStartDate: '2026-07-09T09:45:00',
      OPId: 3,
    }) as Record<string, unknown>;
    assert.equal(out['PatientId'], '••82');
    assert.equal(out['patient_name'], '••••••••es');
    assert.equal(out['phone'], '••••••••23');
    assert.equal(out['AppointmentStartDate'], '2026-07-09T09:45:00');
    assert.equal(out['OPId'], 3);
  });

  it('never masks an appointment reference, even a long numeric one', () => {
    const out = redactValue({ appointment_id: '20260709094500', confirmation: '4155550123', booking: { uid: '9876543210' } });
    assert.deepEqual(out, { appointment_id: '20260709094500', confirmation: '4155550123', booking: { uid: '9876543210' } });
  });

  it('redacts inside JSON strings and falls back to text', () => {
    assert.equal(redactMaybeJson('{"email":"a@b.co","when":"2026-07-09"}'), '{"email":"••••co","when":"2026-07-09"}');
    assert.equal(redactMaybeJson('{not json'), '{not json');
    assert.doesNotMatch(redactMaybeJson('reach me at a.person@example.org'), /person/);
  });
});
