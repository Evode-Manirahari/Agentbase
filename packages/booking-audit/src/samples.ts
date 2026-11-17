// Synthetic call logs, shaped like Retell's GET /v2/get-call response (spec
// revision 2026-11-15). Used by `booking-audit demo` and by the tests.
//
// Every call here is made up. The people, numbers and appointments do not
// exist. They show what the audit reports; they are not evidence about what any
// real call log contains.

type Entry = Record<string, unknown>;

export const agent = (content: string): Entry => ({ role: 'agent', content, words: [] });
export const user = (content: string): Entry => ({ role: 'user', content, words: [] });

export function invoke(id: string, name: string, args: unknown, type: string | null = 'custom'): Entry {
  return {
    role: 'tool_call_invocation',
    tool_call_id: id,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
    ...(type ? { type } : {}),
  };
}

export function result(id: string, content: unknown, successful?: boolean): Entry {
  return {
    role: 'tool_call_result',
    tool_call_id: id,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    ...(successful === undefined ? {} : { successful }),
  };
}

export function retellCall(id: string, entries: unknown[], extra: Entry = {}): Entry {
  return {
    call_id: id,
    call_type: 'phone_call',
    agent_id: 'agent_front_desk',
    agent_version: 34,
    call_status: 'ended',
    direction: 'inbound',
    start_timestamp: Date.UTC(2026, 6, 8, 13, 59),
    end_timestamp: Date.UTC(2026, 6, 8, 14, 3),
    transcript_with_tool_calls: entries,
    ...extra,
  };
}

const slot = (time: string): Entry => ({
  PatientId: 1182,
  AppointmentStartDate: `2026-07-09T${time}:00`,
  OPId: 3,
});

/**
 * Modeled on the public Retell community thread of 2026-07-08: one caller
 * confirms one slot, the engine emits five identical Book_Appointment calls in
 * a single turn, four succeed, and fallback logic books neighbouring slots.
 * Counts are simplified from the thread's (six records across three times here).
 */
export function threadCall(): Entry {
  return retellCall('call_thread', [
    agent('I have 9:45 tomorrow morning. Does that work?'),
    user('Yes, 9:45 works.'),
    invoke('t1', 'Book_Appointment', slot('09:45'), 'mcp'),
    invoke('t2', 'Book_Appointment', slot('09:45'), 'mcp'),
    invoke('t3', 'Book_Appointment', slot('09:45'), 'mcp'),
    invoke('t4', 'Book_Appointment', slot('09:45'), 'mcp'),
    invoke('t5', 'Book_Appointment', slot('09:45'), 'mcp'),
    result('t1', { AppointmentId: 9001 }, true),
    result('t2', { AppointmentId: 9002 }, true),
    result('t3', { AppointmentId: 9003 }, true),
    result('t4', { AppointmentId: 9004 }, true),
    result('t5', { error: 'Already Booked' }, false),
    invoke('t6', 'Book_Appointment', slot('09:30'), 'mcp'),
    result('t6', { AppointmentId: 9005 }, true),
    invoke('t7', 'Book_Appointment', slot('10:15'), 'mcp'),
    result('t7', { AppointmentId: 9006 }, true),
    agent("You're all set for 9:45 tomorrow."),
  ]);
}

/** One caller, one confirmed booking, one true sentence. Nothing to find. */
export function cleanCall(id = 'call_clean'): Entry {
  return retellCall(id, [
    agent('I have Tuesday at 2 PM. Shall I book it?'),
    user('Yes please.'),
    invoke('c1', 'Book_Appointment', { PatientId: 77, AppointmentStartDate: '2026-07-14T14:00:00', OPId: 1 }, 'mcp'),
    result('c1', { AppointmentId: 5001 }, true),
    agent("You're booked for Tuesday at 2 PM."),
  ]);
}

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 10, 9, 15, 0);

/** The dataset behind `booking-audit demo`: one call per kind of finding, plus clean ones. */
export function sampleCalls(): Entry[] {
  return [
    { ...threadCall(), call_id: 'demo_five_in_one_turn', start_timestamp: BASE },

    // The webhook answers before the booking is made. The agent hears "OK".
    retellCall(
      'demo_acknowledged_not_booked',
      [
        agent('I can do Friday at 2 PM. Want me to book it?'),
        user('Yes, and my number is 415-555-0142.'),
        invoke('a1', 'book_appointment', { phone: '415-555-0142', name: 'Sam Example', start: '2026-11-13T14:00:00' }),
        result('a1', { message: 'Workflow was started' }, true),
        agent("You're all set for Friday at 2 PM. You'll get a text shortly."),
      ],
      { agent_id: 'agent_n8n_install', agent_version: 3, start_timestamp: BASE + HOUR },
    ),

    // The agent looks up the calendar and then says it booked. It never did.
    retellCall(
      'demo_said_booked_never_called',
      [
        user('Do you have anything Monday morning?'),
        invoke('s1', 'Available_time_slots', { day: '2026-11-16' }, 'mcp'),
        result('s1', { slots: ['2026-11-16T10:00:00', '2026-11-16T11:30:00'] }, true),
        agent('I have 10 AM or 11:30.'),
        user('Ten is fine.'),
        agent('I am proceeding with the booking. Your appointment is confirmed for Monday at 10 AM.'),
      ],
      { start_timestamp: BASE + 2 * HOUR },
    ),

    // A timeout. This agent does the honest thing and does not claim a booking.
    retellCall(
      'demo_timed_out',
      [
        user('Wednesday at 4 works.'),
        invoke('x1', 'Book_Appointment', { PatientId: 2040, AppointmentStartDate: '2026-11-11T16:00:00', OPId: 2 }, 'mcp'),
        result('x1', 'Request timed out after 20000ms', false),
        agent('I am having trouble reaching the schedule. Someone from the office will call you to confirm.'),
      ],
      { start_timestamp: BASE + 3 * HOUR },
    ),

    // The caller repeats themselves, the tool fires twice, the backend copes.
    retellCall(
      'demo_repeat_deduplicated',
      [
        user('My name is Jordan Sample.'),
        invoke('r1', 'Book_Appointment', { PatientId: 3055, AppointmentStartDate: '2026-11-12T09:00:00', OPId: 1 }, 'mcp'),
        result('r1', { AppointmentId: 7301 }, true),
        user('Jordan Sample.'),
        invoke('r2', 'Book_Appointment', { PatientId: 3055, AppointmentStartDate: '2026-11-12T09:00:00', OPId: 1 }, 'mcp'),
        result('r2', { AppointmentId: 7301 }, true),
        agent("You're booked for Thursday at 9 AM."),
      ],
      { start_timestamp: BASE + 4 * HOUR },
    ),

    { ...cleanCall('demo_clean_1'), start_timestamp: BASE + 5 * HOUR },
    { ...cleanCall('demo_clean_2'), start_timestamp: BASE + 6 * HOUR },
  ];
}
