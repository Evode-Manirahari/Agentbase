import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAttempts, classifyOutcome, identityOf, intentKeyOf, isAvailabilityTool, isBookingTool } from './classify.js';
import { AUTO, invoke, normalize, result, retellCall } from './test-helpers.js';
import type { ToolInvocation, ToolResult } from './types.js';

function inv(name: string, args: unknown = {}, type: string | null = 'custom'): ToolInvocation {
  const call = normalize(retellCall('c', [invoke('x', name, args, type)]));
  const event = call.events[0];
  assert.ok(event && event.kind === 'tool_invocation');
  return event;
}

function res(content: unknown, successful?: boolean): ToolResult {
  const call = normalize(retellCall('c', [result('x', content, successful)]));
  const event = call.events[0];
  assert.ok(event && event.kind === 'tool_result');
  return event;
}

describe('which tools create bookings', () => {
  for (const name of [
    'Book_Appointment',
    'bookAppointment',
    'book-appointment',
    'create_booking',
    'schedule_callback',
    'make_reservation',
    'book_slot',
    // Contains "list". A substring match would have thrown it out.
    'book_specialist_appointment',
  ]) {
    it(`treats ${name} as a booking tool`, () => assert.equal(isBookingTool(inv(name), AUTO), true));
  }

  for (const name of [
    'check_availability',
    'Available_time_slots',
    'get_appointments',
    'cancel_appointment',
    'reschedule_appointment',
    'appointment_lookup',
    'update_booking',
    'end_call',
    'transfer_to_front_desk',
  ]) {
    it(`does not treat ${name} as a booking tool`, () => assert.equal(isBookingTool(inv(name), AUTO), false));
  }

  it('trusts the platform type over the name', () => {
    assert.equal(isBookingTool(inv('cal_tool_7', {}, 'book_appointment_cal'), AUTO), true);
    assert.equal(isBookingTool(inv('book_it', {}, 'check_availability_cal'), AUTO), false);
    assert.equal(isBookingTool(inv('book_it', {}, 'end_call'), AUTO), false);
  });

  it('an explicit list replaces detection entirely', () => {
    const opts = { bookingTools: ['commit_visit'], identityKeys: null };
    assert.equal(isBookingTool(inv('Commit_Visit'), opts), true);
    assert.equal(isBookingTool(inv('Book_Appointment'), opts), false);
  });

  it('recognises availability tools', () => {
    assert.equal(isAvailabilityTool(inv('Available_time_slots')), true);
    assert.equal(isAvailabilityTool(inv('x', {}, 'check_availability_cal')), true);
    assert.equal(isAvailabilityTool(inv('Book_Appointment')), false);
  });
});

describe('booking intent', () => {
  const key = (args: unknown, identityKeys: string[] | null = null): string => {
    const i = inv('Book_Appointment', args);
    return intentKeyOf(i, identityOf(i, identityKeys));
  };

  it('is the same for the same booking regardless of key order', () => {
    assert.equal(key({ who: 'p1', when: '2026-07-09T09:45:00' }), key({ when: '2026-07-09T09:45:00', who: 'p1' }));
  });

  it('ignores free text the model rewrites between repeats', () => {
    assert.equal(
      key({ who: 'p1', when: 't', notes: 'cleaning', execution_message: 'One moment.' }),
      key({ who: 'p1', when: 't', notes: 'Patient wants a cleaning', execution_message: 'Booking that now.' }),
    );
  });

  it('is different for a different slot or a different person', () => {
    assert.notEqual(key({ who: 'p1', when: '09:45' }), key({ who: 'p1', when: '09:30' }));
    assert.notEqual(key({ who: 'p1', when: '09:45' }), key({ who: 'p2', when: '09:45' }));
  });

  it('treats differently formatted phone numbers and casing as the same caller', () => {
    assert.equal(
      key({ phone: '+1 (415) 555-0123', name: 'Dana  Reyes' }),
      key({ phone: '14155550123', name: 'dana reyes' }),
    );
  });

  it('differs by tool: the same arguments to two tools are two intents', () => {
    const a = inv('Book_Appointment', { when: 't' });
    const b = inv('create_booking', { when: 't' });
    assert.notEqual(intentKeyOf(a, identityOf(a, null)), intentKeyOf(b, identityOf(b, null)));
  });

  it('honours --identity, and falls back when none of the keys exist', () => {
    assert.equal(key({ who: 'p1', when: 't', room: 1 }, ['who', 'when']), key({ who: 'p1', when: 't', room: 2 }, ['who', 'when']));
    // "nope" is on neither call. An empty identity would merge every booking.
    assert.notEqual(key({ who: 'p1' }, ['nope']), key({ who: 'p2' }, ['nope']));
  });

  it('still identifies arguments it cannot parse, by their exact text', () => {
    assert.equal(key('not json at all'), key('not json at all'));
    assert.notEqual(key('not json at all'), key('something else'));
  });
});

describe('outcome of a booking attempt', () => {
  const cases: [string, ToolResult | null, 'confirmed' | 'failed' | 'unknown'][] = [
    ['no result recorded', null, 'unknown'],
    ['a reference and a success flag', res({ appointment_id: 'A1' }, true), 'confirmed'],
    ['a reference with no flag', res({ appointment_id: 'A1' }), 'confirmed'],
    ['an explicit rejection', res({ error: 'Already Booked' }, false), 'failed'],
    ['success: false in the body', res({ success: false }), 'failed'],
    ['success: true in the body', res({ success: true }), 'confirmed'],
    ['a success sentence', res('Appointment booked successfully'), 'confirmed'],
    ['a JSON-encoded success sentence', res(JSON.stringify('Booked')), 'confirmed'],
    ['a rejection sentence', res('The slot is no longer available'), 'failed'],
    ['a negated success', res('The appointment could not be booked'), 'failed'],
    ['a conflict status code', res({ statusCode: 409, message: 'conflict' }), 'failed'],
    ['a booking object with a uid', res({ error: null, booking: { uid: 'bk_1' } }), 'confirmed'],
    ['a numeric id at the top', res({ error: false, id: 4412 }), 'confirmed'],
    // The platform says the HTTP call worked. The body says the booking did not.
    ['a 200 that carries a rejection', res({ success: false, message: 'Slot taken' }, true), 'failed'],
    ['a success flag and nothing else', res('', true), 'confirmed'],

    // The unknowns. None of these establishes that nothing happened.
    ['a timeout sentence', res('Request timed out'), 'unknown'],
    ['a gateway timeout', res({ error: 'Gateway Timeout', status: 504 }, false), 'unknown'],
    ['a 500 status', res({ status: 500 }), 'unknown'],
    ['an unsuccessful call that does not say why', res('', false), 'unknown'],
    ['an empty result with no flag', res(''), 'unknown'],
    ['the n8n default acknowledgement', res('Workflow was started', true), 'unknown'],
    ['the same acknowledgement as JSON', res({ message: 'Workflow was started' }, true), 'unknown'],
    ['a pending status', res({ status: 'pending' }, true), 'unknown'],
    ['an id that is too deep to be the appointment', res({ data: { attendees: [{ id: 9 }] } }), 'unknown'],
  ];

  for (const [label, toolResult, expected] of cases) {
    it(`${label} is ${expected}`, () => {
      const { outcome, reason } = classifyOutcome(toolResult);
      assert.equal(outcome, expected, reason);
      assert.ok(reason.length > 0);
    });
  }

  it('collects every appointment reference in the result', () => {
    assert.deepEqual(classifyOutcome(res({ appointmentId: 'A-77', eventId: 'E-9' })).refs, ['A-77', 'E-9']);
    assert.deepEqual(classifyOutcome(res('Done. Confirmation number: QX7-2291')).refs, ['QX7-2291']);
  });

  it('does not mistake a word for a reference', () => {
    const { outcome, refs } = classifyOutcome(res('Appointment number is not available'));
    assert.equal(outcome, 'failed');
    assert.deepEqual(refs, []);
  });

  it('reads a double-encoded JSON result', () => {
    const { outcome, refs } = classifyOutcome(res(JSON.stringify(JSON.stringify({ booking_id: 'B-1' }))));
    assert.equal(outcome, 'confirmed');
    assert.deepEqual(refs, ['B-1']);
  });
});

describe('attempts in a call', () => {
  it('pairs each booking call with its own result and skips other tools', () => {
    const call = normalize(
      retellCall('c', [
        invoke('a', 'Available_time_slots', { day: 'tue' }),
        result('a', { slots: ['09:45'] }, true),
        invoke('b', 'Book_Appointment', { when: '09:45' }),
        result('b', { AppointmentId: 1 }, true),
      ]),
    );
    const attempts = buildAttempts(call, AUTO);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.outcome, 'confirmed');
    assert.deepEqual(attempts[0]?.appointmentRefs, ['1']);
  });

  it('counts a tool_call_id the log repeats as one request', () => {
    const call = normalize(
      retellCall('c', [
        invoke('same', 'Book_Appointment', { when: '09:45' }),
        invoke('same', 'Book_Appointment', { when: '09:45' }),
        result('same', { AppointmentId: 1 }, true),
      ]),
    );
    assert.equal(buildAttempts(call, AUTO).length, 1);
  });
});
