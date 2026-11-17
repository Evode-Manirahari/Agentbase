import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentSays, CommitLayer, intentKey, MockBookingBackend, render, runScenarios } from './repro.mjs';

const INTENT = { patientId: 1, start: '2026-07-09T09:45:00', opId: 3 };

describe('the reproduction', async () => {
  const run = await runScenarios();
  const [five, lost, repeat] = run.scenarios;

  it('unprotected, each scenario creates more than the one appointment asked for', () => {
    assert.equal(five.unprotected.appointments, 5);
    assert.equal(lost.unprotected.appointments, 2);
    assert.equal(repeat.unprotected.appointments, 2);
  });

  it('through the protocol, each scenario creates one appointment from one request', () => {
    for (const s of run.scenarios) {
      assert.equal(s.protected.appointments, 1, s.name);
      assert.equal(s.protected.requests, 1, s.name);
    }
  });

  it('five in one turn: four are answered from the first receipt', () => {
    assert.deepEqual(five.protected.states, ['confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed']);
    assert.match(five.protected.how, /^4 of 5/);
  });

  it('a lost response is held unknown, not retried, and the agent does not claim a booking', () => {
    assert.deepEqual(lost.protected.states, ['unknown', 'unknown', 'confirmed']);
    assert.doesNotMatch(lost.protected.says, /booked for/);
    assert.match(lost.protected.says, /couldn't confirm/);
  });

  it('the condition: with no lookup the attempt stays unknown and is still sent once', () => {
    assert.deepEqual(
      { state: run.condition.state, requests: run.condition.requests, appointments: run.condition.appointments },
      { state: 'unknown', requests: 1, appointments: 1 },
    );
    assert.match(render(run), /Retrying is only safe where\s+the backend deduplicates on a key/);
  });
});

describe('the protocol in miniature', () => {
  it('a rejection is a known failure and is replayed, not re-sent', async () => {
    const backend = new MockBookingBackend({ check: 'racy' });
    await backend.book(INTENT);
    const layer = new CommitLayer(backend);
    const first = await layer.commit(INTENT);
    const second = await layer.commit(INTENT);
    assert.equal(first.state, 'failed');
    assert.deepEqual([second.state, second.replayed], ['failed', true]);
    assert.equal(backend.requests, 2); // the seed booking and one attempt
    assert.match(agentSays(first), /didn't go through/);
  });

  it('a different slot or a different person is a different booking', async () => {
    const backend = new MockBookingBackend();
    const layer = new CommitLayer(backend);
    await layer.commit(INTENT);
    await layer.commit({ ...INTENT, start: '2026-07-09T10:15:00' });
    await layer.commit({ ...INTENT, patientId: 2 });
    assert.equal(backend.appointments.length, 3);
  });

  it('the intent key ignores argument order', () => {
    assert.equal(intentKey({ a: 1, b: 2 }), intentKey({ b: 2, a: 1 }));
    assert.notEqual(intentKey({ a: 1, b: 2 }), intentKey({ a: 1, b: 3 }));
  });
});
