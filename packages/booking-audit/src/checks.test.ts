import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasActionableFindings } from './audit.js';
import { agent, audit, cleanCall, invoke, result, retellCall, threadCall, user } from './test-helpers.js';
import type { CheckId, Finding, Severity } from './types.js';

const BOOK = 'Book_Appointment';
const at = (when: string, who = 'p1'): Record<string, unknown> => ({ who, when });

function findingsOf(raw: unknown, others: unknown[] = []): Finding[] {
  const report = audit([raw, ...others]).flagged.find((r) => r.call.id === (raw as { call_id: string }).call_id);
  return report ? report.findings : [];
}

function only(findings: Finding[], check: CheckId): Finding {
  const matches = findings.filter((f) => f.check === check);
  assert.equal(matches.length, 1, `expected exactly one ${check}, got ${JSON.stringify(findings.map((f) => f.check))}`);
  const [finding] = matches;
  assert.ok(finding);
  return finding;
}

function shape(findings: Finding[]): [CheckId, Severity][] {
  return findings.map((f) => [f.check, f.severity]);
}

describe('the failure from the public thread', () => {
  const findings = findingsOf(threadCall());

  it('reports the repeated booking as high, with the four distinct appointments', () => {
    const f1 = only(findings, 'F1');
    assert.equal(f1.severity, 'high');
    assert.match(f1.detail, /sent 5 times and 4 were confirmed, with 4 different appointment references/);
    assert.match(f1.whatToCheck, /9001, 9002, 9003, 9004/);
  });

  it('reports the two fallback bookings the caller never agreed to', () => {
    const f2 = only(findings, 'F2');
    assert.equal(f2.severity, 'high');
    assert.match(f2.detail, /2 bookings were confirmed/);
    assert.match(f2.detail, /09:30/);
    assert.match(f2.detail, /10:15/);
    assert.match(f2.whatToCheck, /9005, 9006/);
  });

  it('does not call the closing sentence unverified: a confirmed result precedes it', () => {
    assert.deepEqual(shape(findings), [
      ['F1', 'high'],
      ['F2', 'high'],
    ]);
  });
});

describe('calls with nothing wrong', () => {
  it('a single confirmed booking and a true sentence', () => {
    assert.deepEqual(findingsOf(cleanCall()), []);
  });

  it('two different appointments with the caller speaking in between', () => {
    const call = retellCall('c', [
      user('Tuesday at nine for me.'),
      invoke('a', BOOK, at('tue-09')),
      result('a', { AppointmentId: 1 }, true),
      agent("You're booked for Tuesday at 9."),
      user('And Thursday at three for my son.'),
      invoke('b', BOOK, at('thu-15', 'p2')),
      result('b', { AppointmentId: 2 }, true),
      agent("He's in for Thursday at 3. You're booked for both."),
    ]);
    assert.deepEqual(findingsOf(call), []);
  });

  it('two appointments asked for in one breath, both confirmed first time', () => {
    const call = retellCall('c', [
      user('Book me Tuesday at nine and Thursday at three.'),
      invoke('a', BOOK, at('tue-09')),
      result('a', { AppointmentId: 1 }, true),
      invoke('b', BOOK, at('thu-15')),
      result('b', { AppointmentId: 2 }, true),
      agent("You're booked for both."),
    ]);
    assert.deepEqual(findingsOf(call), []);
  });

  it('a failed slot, the caller agrees to another, and that one is booked', () => {
    const call = retellCall('c', [
      user('Nine forty-five please.'),
      invoke('a', BOOK, at('09:45')),
      result('a', { error: 'Already Booked' }, false),
      agent('That one just went. I have 10:15, does that work?'),
      user('Sure.'),
      invoke('b', BOOK, at('10:15')),
      result('b', { AppointmentId: 2 }, true),
      agent("You're booked for 10:15."),
    ]);
    assert.deepEqual(findingsOf(call), []);
  });
});

describe('F1 repeated booking', () => {
  it('is low when the backend returned the same appointment for every repeat', () => {
    const call = retellCall('c', [
      user('Yes.'),
      invoke('a', BOOK, at('09:45')),
      invoke('b', BOOK, at('09:45')),
      // One appointment can carry two references. They must not read as two appointments.
      result('a', { AppointmentId: 7, eventId: 'ev_7' }, true),
      result('b', { AppointmentId: 7, eventId: 'ev_7' }, true),
    ]);
    const f1 = only(findingsOf(call), 'F1');
    assert.equal(f1.severity, 'low');
    assert.match(f1.detail, /deduplicated/);
  });

  it('is low when the backend rejected the repeats', () => {
    const call = retellCall('c', [
      user('Yes.'),
      invoke('a', BOOK, at('09:45')),
      invoke('b', BOOK, at('09:45')),
      result('a', { AppointmentId: 7 }, true),
      result('b', { error: 'Already Booked' }, false),
    ]);
    assert.deepEqual(shape(findingsOf(call)), [['F1', 'low']]);
  });

  it('is medium when a repeat has an unknown outcome, and leaves F4 out of it', () => {
    const call = retellCall('c', [
      user('Yes.'),
      invoke('a', BOOK, at('09:45')),
      invoke('b', BOOK, at('09:45')),
      result('a', { AppointmentId: 7 }, true),
    ]);
    assert.deepEqual(shape(findingsOf(call)), [['F1', 'medium']]);
  });

  it('is high when confirmations carry no reference to compare', () => {
    const call = retellCall('c', [
      user('Yes.'),
      invoke('a', BOOK, at('09:45')),
      invoke('b', BOOK, at('09:45')),
      result('a', 'Appointment booked successfully', true),
      result('b', 'Appointment booked successfully', true),
    ]);
    const f1 = only(findingsOf(call), 'F1');
    assert.equal(f1.severity, 'high');
    assert.match(f1.detail, /do not show whether they are the same appointment/);
  });

  it('catches a repeat across turns, when the caller says the same thing twice', () => {
    const call = retellCall('c', [
      user('My name is Dana Reyes.'),
      invoke('a', 'create_appointment', { name: 'Dana Reyes', when: 'tue-09' }, 'mcp'),
      result('a', { appointment_id: 'A1' }, true),
      user('Dana Reyes.'),
      invoke('b', 'create_appointment', { name: 'dana reyes', when: 'tue-09' }, 'mcp'),
      result('b', { appointment_id: 'A2' }, true),
    ]);
    assert.deepEqual(shape(findingsOf(call)), [['F1', 'high']]);
  });
});

describe('F2 booking the caller never confirmed', () => {
  it('flags a different slot booked straight after a failure, with no caller turn', () => {
    const call = retellCall('c', [
      user('Nine forty-five please.'),
      invoke('a', BOOK, at('09:45')),
      result('a', { error: 'Already Booked' }, false),
      invoke('b', BOOK, at('10:15')),
      result('b', { AppointmentId: 2 }, true),
      agent("You're booked for 10:15."),
    ]);
    const f2 = only(findingsOf(call), 'F2');
    assert.equal(f2.severity, 'high');
    assert.match(f2.detail, /1 booking was confirmed \(10:15\)/);
  });
});

describe('F3 unverified booking claim', () => {
  // The agent books in another call, so it has a booking tool.
  const elsewhere = cleanCall('call_elsewhere');

  it('flags a claim when no booking tool had been called', () => {
    const call = retellCall('c', [user('Tuesday at 9:45.'), agent("You're all set for Tuesday at 9:45.")]);
    const f3 = only(findingsOf(call, [elsewhere]), 'F3');
    assert.equal(f3.severity, 'high');
    assert.equal(f3.quote, "You're all set for Tuesday at 9:45.");
    assert.match(f3.detail, /No booking tool had been called\./);
    assert.match(f3.detail, /does not prove the appointment is missing/);
  });

  it('says so when only the availability check ran', () => {
    const call = retellCall('c', [
      invoke('a', 'Available_time_slots', { day: 'tue' }),
      result('a', { slots: ['09:45'] }, true),
      agent('I am proceeding with the booking. Your appointment is confirmed for Tuesday at 9:45.'),
    ]);
    assert.match(only(findingsOf(call, [elsewhere]), 'F3').detail, /Only the availability check had run/);
  });

  it('flags a claim after a failed booking', () => {
    const call = retellCall('c', [
      invoke('a', BOOK, at('09:45')),
      result('a', { error: 'Slot taken' }, false),
      agent("You're booked for 9:45."),
    ]);
    assert.match(only(findingsOf(call), 'F3').detail, /it failed/);
  });

  it('flags a claim while the outcome is unknown, and raises F4 with it', () => {
    const call = retellCall('c', [
      user('Yes.'),
      invoke('a', BOOK, at('09:45')),
      agent("You're booked for Tuesday at 9:45."),
    ]);
    const findings = findingsOf(call);
    assert.deepEqual(shape(findings), [
      ['F3', 'high'],
      ['F4', 'medium'],
    ]);
    assert.match(only(findings, 'F3').detail, /its outcome is unknown/);
    assert.match(only(findings, 'F4').detail, /No result was recorded/);
  });

  it('treats a bare acknowledgement as unknown, not as a booking', () => {
    const call = retellCall('c', [
      user('Friday at two.'),
      invoke('a', 'book_appointment', at('fri-14')),
      result('a', { message: 'Workflow was started' }, true),
      agent("You're all set for Friday at 2 PM."),
    ]);
    assert.deepEqual(shape(findingsOf(call)), [
      ['F3', 'high'],
      ['F4', 'medium'],
    ]);
  });

  it('is low when the agent spoke first and the booking was confirmed later', () => {
    const call = retellCall('c', [
      user('Yes.'),
      agent("You're booked for Tuesday."),
      invoke('a', BOOK, at('tue')),
      result('a', { AppointmentId: 1 }, true),
    ]);
    const f3 = only(findingsOf(call), 'F3');
    assert.equal(f3.severity, 'low');
    assert.match(f3.detail, /confirmed later in the call/);
  });

  it('is low when post-call automation made the booking', () => {
    const call = retellCall('c', [user('Yes.'), agent("I've scheduled your visit for Monday at 10.")], {
      post_session_transcript_with_tool_calls: [invoke('p', BOOK, at('mon-10')), result('p', { AppointmentId: 3 }, true)],
    });
    const f3 = only(findingsOf(call), 'F3');
    assert.equal(f3.severity, 'low');
    assert.match(f3.detail, /after the call ended/);
  });

  it('reports an agent that never books as one note, not a finding per call', () => {
    const talk = (id: string): Record<string, unknown> =>
      retellCall(id, [agent("I've scheduled your appointment for Monday at 10.")], { agent_id: 'agent_no_tools' });
    const result1 = audit([talk('n1'), talk('n2'), cleanCall()]);
    assert.equal(result1.flagged.length, 0);
    assert.deepEqual(result1.agentsWithoutBookingTool, [{ agentId: 'agent_no_tools', callsWithClaims: 2 }]);
    assert.match(result1.notes.join('\n'), /agent_no_tools told the caller a booking was made in 2 calls/);

    // The moment that agent is seen booking anywhere, its bare claims are findings.
    const books = retellCall('n3', [invoke('a', BOOK, at('x')), result('a', { AppointmentId: 9 }, true)], {
      agent_id: 'agent_no_tools',
    });
    assert.equal(audit([talk('n1'), talk('n2'), books]).flagged.length, 2);
  });
});

describe('F4 unknown outcome', () => {
  it('flags a timeout that nobody followed up', () => {
    const call = retellCall('c', [
      user('Yes.'),
      invoke('a', BOOK, at('09:45')),
      result('a', 'Request timed out', false),
      agent('I am having trouble with the calendar. Someone will call you back.'),
    ]);
    const f4 = only(findingsOf(call), 'F4');
    assert.equal(f4.severity, 'medium');
    assert.match(f4.detail, /1 booking has no known outcome \(09:45\)/);
    assert.match(f4.detail, /timeout or server error/);
  });
});

describe('exit-code rule', () => {
  it('a low finding alone is not actionable', () => {
    const lowOnly = retellCall('c', [
      user('Yes.'),
      invoke('a', BOOK, at('09:45')),
      invoke('b', BOOK, at('09:45')),
      result('a', { AppointmentId: 7 }, true),
      result('b', { AppointmentId: 7 }, true),
    ]);
    assert.equal(hasActionableFindings(audit([lowOnly])), false);
    assert.equal(hasActionableFindings(audit([threadCall()])), true);
    assert.equal(hasActionableFindings(audit([cleanCall()])), false);
  });
});
