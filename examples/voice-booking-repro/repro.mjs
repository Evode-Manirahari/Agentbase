// Reproduces three public voice-agent booking failures against a mock booking
// backend, then runs the same traffic through the commit protocol.
//
//   node examples/voice-booking-repro/repro.mjs
//
// No install, no API keys, no network. Node 22+.
//
// What is real here and what is not:
//   - The failures are modeled on public reports (linked in the README). The
//     backend, the callers and the appointments are made up.
//   - CommitLayer below is a ~60-line, in-memory restatement of the protocol in
//     docs/effect-commit.md. The production implementation is
//     apps/api/src/actions/effect-dispatcher.service.ts, which reserves in
//     Postgres and is tested by fault injection. This file does not show crash
//     survival, because a Map does not survive a crash. That test is
//     apps/api/src/actions/effect-dispatcher.test.ts.
//   - The backend counts the appointments that exist on ITS side. That is the
//     only number that matters: effects, not calls.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export class BookingRejected extends Error {}
export class ResponseLost extends Error {}

const sameSlot = (a, b) => a.patientId === b.patientId && a.start === b.start && a.opId === b.opId;

export class MockBookingBackend {
  /**
   * @param {object} opts
   * @param {'racy'|'none'} opts.check  'racy': an "already booked?" check that
   *   reads, waits, then writes (the bug in the Retell thread: five requests all
   *   pass the check before any of them commits). 'none': a plain calendar API
   *   that accepts overlapping events.
   * @param {number} opts.dropResponses  How many successful writes lose their response.
   * @param {boolean} opts.lookup  Whether the backend can be asked "does this booking exist?"
   */
  constructor({ check = 'none', dropResponses = 0, lookup = true } = {}) {
    this.check = check;
    this.dropResponses = dropResponses;
    this.appointments = [];
    this.requests = 0;
    if (lookup) this.find = async (intent) => this.appointments.filter((a) => sameSlot(a, intent));
  }

  async book(intent) {
    this.requests += 1;
    const taken = this.check === 'racy' && this.appointments.some((a) => sameSlot(a, intent));
    await delay(5); // The window between the check and the write.
    if (taken) throw new BookingRejected('Already Booked');

    const appointment = { id: `apt_${this.appointments.length + 1}`, ...intent };
    this.appointments.push(appointment);

    if (this.dropResponses > 0) {
      this.dropResponses -= 1;
      // The appointment exists. The caller of this function will never hear so.
      throw new ResponseLost('timed out waiting for the booking backend');
    }
    return { appointmentId: appointment.id };
  }
}

/** Same person, same slot, same room: the same booking, whatever tool_call_id it arrived under. */
export function intentKey(intent) {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(intent).sort(([a], [b]) => (a < b ? -1 : 1))));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export class CommitLayer {
  #receipts = new Map();

  constructor(backend) {
    this.backend = backend;
  }

  /** Returns { state: 'confirmed' | 'failed' | 'unknown', appointmentId, replayed }. */
  async commit(intent) {
    const key = intentKey(intent);
    const prior = this.#receipts.get(key);
    if (prior) {
      // Replay: wait for the first attempt's verdict and return it. Nothing is re-sent.
      await prior.settled;
      return { ...view(prior), replayed: true };
    }

    // 1. Reserve BEFORE dispatch. There is no await between the lookup above and
    //    this set, so a concurrent request with the same intent cannot get past.
    //    In production this is a unique index in Postgres, not a Map.
    // 2. Write the attempt down as indeterminate before the request leaves.
    const receipt = { state: 'indeterminate', appointmentId: null, reason: null, intent, settled: null };
    this.#receipts.set(key, receipt);
    receipt.settled = this.#dispatch(receipt);
    await receipt.settled;
    return { ...view(receipt), replayed: false };
  }

  async #dispatch(receipt) {
    try {
      const res = await this.backend.book(receipt.intent);
      receipt.state = 'confirmed';
      receipt.appointmentId = res.appointmentId;
    } catch (err) {
      if (err instanceof BookingRejected) {
        receipt.state = 'failed';
        receipt.reason = err.message;
      } else {
        // 3. Never upgrade an unknown to a known. A timeout does not say that
        //    nothing happened, so the attempt stays indeterminate. No retry.
        receipt.reason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  /**
   * End a quarantine by LOOKING, not by re-sending. Only possible where the
   * backend can be asked. Finding nothing is not treated as proof either: the
   * attempt stays unknown for a human, which is the conservative choice a demo
   * can afford and a production system would refine with the backend's own
   * processing window.
   */
  async reconcile(intent) {
    const receipt = this.#receipts.get(intentKey(intent));
    if (!receipt) return null;
    if (receipt.state === 'indeterminate' && typeof this.backend.find === 'function') {
      const found = await this.backend.find(receipt.intent);
      if (found.length === 1) {
        receipt.state = 'confirmed';
        receipt.appointmentId = found[0].id;
      }
    }
    return { ...view(receipt), replayed: false };
  }
}

function view(receipt) {
  return {
    state: receipt.state === 'indeterminate' ? 'unknown' : receipt.state,
    appointmentId: receipt.appointmentId,
    reason: receipt.reason,
  };
}

/** The sentence the caller hears next. This is the whole point of the unknown state. */
export function agentSays(outcome) {
  if (outcome.state === 'confirmed') return "You're booked for 9:45.";
  if (outcome.state === 'failed') return "That time didn't go through. Let me offer you another.";
  return "I couldn't confirm that booking. The office will call you to confirm.";
}

const INTENT = { patientId: 1182, start: '2026-07-09T09:45:00', opId: 3 };

/** 1. Five identical booking calls emitted in one turn (Retell community thread, 2026-07-08). */
async function fiveInOneTurn() {
  const bare = new MockBookingBackend({ check: 'racy' });
  await Promise.allSettled(Array.from({ length: 5 }, () => bare.book(INTENT)));

  const guarded = new MockBookingBackend({ check: 'racy' });
  const layer = new CommitLayer(guarded);
  const outcomes = await Promise.all(Array.from({ length: 5 }, () => layer.commit(INTENT)));

  return {
    name: 'Five identical booking calls in one turn',
    backend: 'has an "already booked?" check, but it reads, waits, then writes',
    unprotected: { appointments: bare.appointments.length, requests: bare.requests, says: "You're booked for 9:45." },
    protected: {
      appointments: guarded.appointments.length,
      requests: guarded.requests,
      says: agentSays(outcomes[0]),
      how: `${outcomes.filter((o) => o.replayed).length} of 5 were answered from the first attempt's receipt`,
      states: outcomes.map((o) => o.state),
    },
  };
}

/** 2. The booking lands, the response is lost, the client retries (AAIF failure analysis, 2026-10-29). */
async function responseLost() {
  const bare = new MockBookingBackend({ dropResponses: 1 });
  let said;
  try {
    await bare.book(INTENT);
  } catch {
    await bare.book(INTENT); // "It timed out, try again." The reflex that books twice.
  }
  said = "You're booked for 9:45.";

  const guarded = new MockBookingBackend({ dropResponses: 1 });
  const layer = new CommitLayer(guarded);
  const first = await layer.commit(INTENT);
  const retry = await layer.commit(INTENT); // The agent retries anyway. Nothing is re-sent.
  const saysDuringCall = agentSays(first);
  const afterLookup = await layer.reconcile(INTENT);

  return {
    name: 'The booking lands, the response is lost',
    backend: 'accepts overlapping events, like a plain calendar API; can be looked up',
    unprotected: { appointments: bare.appointments.length, requests: bare.requests, says: said },
    protected: {
      appointments: guarded.appointments.length,
      requests: guarded.requests,
      says: saysDuringCall,
      how: `held as ${first.state}, the retry was not sent, then a lookup found ${afterLookup.appointmentId}`,
      states: [first.state, retry.state, afterLookup.state],
    },
  };
}

/** 3. The caller repeats themselves and the tool fires again under a new tool_call_id (LiveKit thread, 2026-01-21). */
async function callerRepeats() {
  const bare = new MockBookingBackend();
  await bare.book(INTENT);
  await bare.book(INTENT);

  const guarded = new MockBookingBackend();
  const layer = new CommitLayer(guarded);
  const first = await layer.commit(INTENT);
  const second = await layer.commit(INTENT);

  return {
    name: 'The caller repeats, the tool fires again',
    backend: 'accepts overlapping events, like a plain calendar API',
    unprotected: { appointments: bare.appointments.length, requests: bare.requests, says: "You're booked for 9:45." },
    protected: {
      appointments: guarded.appointments.length,
      requests: guarded.requests,
      says: agentSays(second),
      how: 'the second call matched the first by booking intent and was answered from its receipt',
      states: [first.state, second.state],
    },
  };
}

/** The condition. A backend that cannot be looked up: the attempt stays unknown. It is still not re-sent. */
async function unknownStaysUnknown() {
  const backend = new MockBookingBackend({ dropResponses: 1, lookup: false });
  const layer = new CommitLayer(backend);
  const first = await layer.commit(INTENT);
  await layer.commit(INTENT);
  const after = await layer.reconcile(INTENT);
  return { state: after.state, requests: backend.requests, appointments: backend.appointments.length, says: agentSays(first) };
}

export async function runScenarios() {
  return {
    scenarios: [await fiveInOneTurn(), await responseLost(), await callerRepeats()],
    condition: await unknownStaysUnknown(),
  };
}

export function render({ scenarios, condition }) {
  const lines = [];
  lines.push('Appointments that exist in the booking backend afterwards. The caller asked for one.');
  lines.push('');
  const width = Math.max(...scenarios.map((s) => s.name.length)) + 3;
  lines.push(`   ${'Scenario'.padEnd(width)}  Unprotected   Through the commit protocol`);
  scenarios.forEach((s, i) => {
    const row = `${i + 1}. ${s.name}`.padEnd(width + 3);
    lines.push(`${row}  ${String(s.unprotected.appointments).padEnd(13)} ${s.protected.appointments}`);
  });
  lines.push('');
  scenarios.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.name}`);
    lines.push(`   backend:      ${s.backend}`);
    lines.push(`   unprotected:  ${s.unprotected.requests} requests reached the backend, ${s.unprotected.appointments} appointments. Agent: "${s.unprotected.says}"`);
    lines.push(`   protected:    ${s.protected.requests} request reached the backend, ${s.protected.appointments} appointment. Agent: "${s.protected.says}"`);
    lines.push(`                 ${s.protected.how}`);
    lines.push('');
  });
  lines.push('The condition, which ships with the claim');
  lines.push(`   When the response is lost and the backend cannot be looked up, the attempt stays ${condition.state}.`);
  lines.push(`   ${condition.requests} request was sent, the retry was not, and the agent said: "${condition.says}"`);
  lines.push('   The protocol never re-sends a booking whose outcome it does not know. Retrying is only safe where');
  lines.push('   the backend deduplicates on a key, and an unknown is only settled automatically where the backend');
  lines.push('   can be looked up. Where neither holds, a human checks the booking system, and until then the');
  lines.push('   caller is told the truth.');
  return lines.join('\n');
}

function invokedDirectly() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) console.log(render(await runScenarios()));
