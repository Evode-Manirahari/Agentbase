# voice-booking-repro

Three public voice-agent booking failures, reproduced against a mock booking backend, then run through a commit protocol that holds each to one booking.

```bash
node examples/voice-booking-repro/repro.mjs
```

No install, no API keys, no network. Node 22 or newer.

```text
Appointments that exist in the booking backend afterwards. The caller asked for one.

   Scenario                                     Unprotected   Through the commit protocol
1. Five identical booking calls in one turn     5             1
2. The booking lands, the response is lost      2             1
3. The caller repeats, the tool fires again     2             1
```

The script also prints, for each scenario, how many requests reached the backend and the sentence the agent says next.

## The three failures

| # | What happens | Public report |
|---|---|---|
| 1 | After a timeout, the engine emits five identical `Book_Appointment` calls in one turn. All five pass the backend's "already booked?" check before any of them commits. | [Retell community, 2026-07-08](https://community.retellai.com/t/book-appointment-tool-calls-fired-in-a-single-llm-turn-after-streaming-timeout-resulted-in-multiple-appointments-booked-for-one-requested-slot/3301). In that thread four of the five succeeded; this mock lets all five through. |
| 2 | The backend creates the appointment and the response is lost. The client sees a timeout and retries. | [Agentic AI Foundation, 2026-10-29](https://aaif.io/blog/where-voice-agents-fail-in-production-part-2-tools-recovery-and-observability): "A timeout cannot safely be treated as proof that nothing happened." |
| 3 | The caller repeats themselves, speech is transcribed twice, and the booking tool fires again under a new tool-call ID. | [LiveKit community, 2026-01-21](https://community.livekit.io/t/duplicate-tool-calls-when-user-repeats-information/183) |

## What the protocol does differently

1. **Reserves before it dispatches.** The booking intent (same person, same slot) is claimed before any request leaves. A second request with the same intent never reaches the backend; it waits for the first one's verdict and gets that.
2. **Writes the attempt down as unknown before it happens.**
3. **Never upgrades an unknown to a known.** A timeout does not say that nothing happened, so the attempt stays unknown and is not retried.
4. **Ends an unknown by looking, not by re-sending.** Where the backend can be asked whether the booking exists, a lookup settles it.

In scenario 2 the difference is the sentence. Unprotected, the agent retries, books twice, and says "You're booked." Through the protocol, the agent says "I couldn't confirm that booking. The office will call you to confirm," one request is sent, and a lookup afterwards finds the one appointment.

## The condition

The protocol never re-sends a booking whose outcome it does not know. Retrying is only safe where the backend deduplicates on a key, and an unknown is only settled automatically where the backend can be looked up. Where neither holds, a human checks the booking system, and until then the caller is told the truth. The script demonstrates this case too and prints it last.

## What is real here and what is not

- The backend, the callers and the appointments are **made up**. The failure shapes come from the public reports above.
- `CommitLayer` in `repro.mjs` is a short, in-memory restatement of the protocol in [`docs/effect-commit.md`](../../docs/effect-commit.md). The production implementation is `apps/api/src/actions/effect-dispatcher.service.ts`, which reserves in Postgres.
- This script does **not** show crash survival, because an in-memory map does not survive a crash. That is tested by fault injection in `apps/api/src/actions/effect-dispatcher.test.ts`.
- Nothing here is wired to Retell, Vapi or any real booking system. The endpoint that would sit in front of a real booking webhook is not built yet. See [`TODOS.md`](../../TODOS.md) for when it will be.

## Find out whether this is happening to you

```bash
pnpm --filter @agentbase/booking-audit start audit --retell --since 30d
```

[`packages/booking-audit`](../../packages/booking-audit) reads your own call logs, on your machine, and reports repeated bookings, bookings the caller never confirmed, unverified booking claims and unknown outcomes.

## Tests

```bash
node --test examples/voice-booking-repro/repro.test.mjs
```
