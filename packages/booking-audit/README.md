# booking-audit

Find the bookings your voice agent duplicated, never confirmed with the caller, or never made.

Read-only. Runs on your machine. Sends nothing anywhere except the requests to your own voice platform that fetch your own calls.

```text
booking-audit 0.1.0  (Retell API, calls since 2026-10-17)

Booking tools detected:
  Book_Appointment  (131 tool calls, mcp)  same booking = same PatientId, AppointmentStartDate, OPId

Calls scanned: 412   with booking attempts: 118   booking attempts: 131
Outcomes: 109 confirmed, 14 failed, 8 unknown

F1  Repeated booking                    3  (2 high, 1 low)
F2  Booking the caller never confirmed  1  (1 high)
F3  Unverified booking claim            9  (7 high, 2 low)
F4  Unknown booking outcome             4  (4 medium)

17 of 412 calls have findings.
Report: ./booking-audit-report/report.html
```

The numbers above are an illustration of the output format, not a measurement of anyone's calls.

## Why

When a voice agent's booking tool call times out, fires twice, or never fires, the caller still hears a sentence. The platform's advice is to make your endpoint idempotent and to check the record before retrying. Most builders find out the other way, when a client forwards a complaint.

A public example, from a Retell community thread in July 2026: one caller confirmed one slot, the engine emitted five identical `Book_Appointment` calls in a single turn, four succeeded, and fallback logic booked two more slots. This tool's `demo` command includes a call modeled on that thread.

## Try it in ten seconds

No key, no network. The demo runs the audit on built-in, made-up calls and writes a real report.

```bash
git clone https://github.com/Evode-Manirahari/Agentbase && cd Agentbase
pnpm install
pnpm --filter @agentbase/booking-audit start demo
open packages/booking-audit/booking-audit-demo/report.html
```

The package is not on npm yet. When it is, this becomes one `npx` line.

## Run it on your own calls

**From the Retell API.** The key is read from the environment, never from a flag, so it does not land in your shell history.

```bash
RETELL_API_KEY=key_... pnpm --filter @agentbase/booking-audit start audit --retell --since 30d
```

**From files you already exported.** For when you would rather not give a key to anything. Point it at one JSON file or a folder of them. Each file may hold one call object, an array of calls, or a list response.

```bash
pnpm --filter @agentbase/booking-audit start audit --from ./my-calls
```

It writes `booking-audit-report/report.html` (one self-contained file, no scripts, loads nothing) and `findings.json`.

## What it checks

| Check | Flags | Does not prove |
|---|---|---|
| **F1 Repeated booking** | The same booking (same tool, same person, same slot) sent more than once in one call. | High when two or more were confirmed as different appointments. Low when your backend rejected or deduplicated the repeats. |
| **F2 Booking the caller never confirmed** | A second, different booking confirmed right after a booking attempt went wrong, with no caller speech in between. | Which booking the caller wanted. |
| **F3 Unverified booking claim** | The agent said a booking was made and no confirmed booking result came before that sentence. | That the appointment is missing. It is an unverified claim. Only your booking system can say. |
| **F4 Unknown booking outcome** | A booking was sent and the log does not show whether it was made. | That nothing happened. A timeout is not proof of that. |

Every finding ends with what to check in your booking system, because this tool cannot look there for you.

### How an outcome is read

The audit never upgrades an unknown to a known.

- **confirmed**: the result carries an appointment reference, or says the booking succeeded, or the platform marked the call successful and nothing in the result contradicts it.
- **failed**: the result is an explicit rejection (`"error": "Already Booked"`, `success: false`, a 4xx, "no longer available").
- **unknown**: no result was recorded, or the result is a timeout or a 5xx, or the platform marked the call unsuccessful without saying why, or the tool only acknowledged the request. `"Workflow was started"` means the request arrived. It does not mean an appointment exists.

### What counts as the same booking

Two calls to a booking tool are the same booking when the tool and its arguments match, ignoring free-text arguments the model rewrites between repeats (notes, reason, message). A different slot or a different person is a different booking, so a caller who books two real appointments is not flagged. The arguments used are printed at the top of every run. Override them with `--identity`.

## Options

```text
--since <when>          30d, 12h, 2w, or a date like 2026-11-01. Default 30d with --retell.
--agent <id>            Only this agent. Repeatable. (--retell)
--booking-tool <name>   Treat this tool as a booking tool. Repeatable. Replaces auto-detection.
--identity <a,b>        Arguments that make two calls the same booking.
--out <dir>             Where to write the report. Default ./booking-audit-report
--max-calls <n>         Stop after this many calls. Default 2000.
--no-redact             Do not mask phone numbers, emails and name-like values.
--no-cache              Do not keep fetched calls in ./.booking-audit-cache
--json                  Print findings as JSON and write no files.
--share-summary         Also print one line of counts, safe to paste publicly.
```

Exit codes: `0` no high or medium findings, `1` high or medium findings, `2` error. That makes it usable from cron or CI:

```bash
booking-audit audit --retell --since 24h || notify-someone
```

## Privacy

- **Nothing is uploaded.** No telemetry, no analytics, no account. The only network requests are to your voice platform's API, with your key, for your calls.
- **The report is redacted by default.** Phone numbers, emails, and the values of name-like arguments are masked. Slot times and appointment references are kept, because they are the evidence.
- **A name somebody said out loud is not removed.** Nothing here can tell "Tuesday" from "Teresa" in free speech. If your platform scrubs transcripts, the audit reads the scrubbed version.
- **Fetched calls are cached** in `./.booking-audit-cache`, outside the report folder, so a rerun does not refetch. The cache holds raw transcripts. Delete it when you are done, or pass `--no-cache`.
- **Zero runtime dependencies.** The whole thing is a few files you can read.

## What it cannot see

- **Your booking system.** It reads the call log and nothing else. A "confirmed" here means the log says so.
- **Bookings created after the call** by a separate automation, unless the platform logs them as post-call tool calls. An agent that says "you're booked" and never calls a booking tool is reported once, as a note about that agent.
- **Unusual phrasings.** Claim detection is deterministic pattern matching, on purpose: no model call means no transcript leaves your machine. It will miss some claims. Each one it does flag is shown with the exact sentence so you can judge it in seconds.
- **Platforms other than Retell.** Vapi is next.

## Status

Version 0.1. Tested against hand-built fixtures shaped like the Retell API reference (spec revision 2026-11-15). It has not yet been run against a large body of real call logs. If it gets something wrong on yours, that is the most useful thing you can tell us: open an issue with the `--share-summary` line and what you expected.

## Development

```bash
pnpm --filter @agentbase/booking-audit test        # node:test, no services needed
pnpm --filter @agentbase/booking-audit typecheck
pnpm --filter @agentbase/booking-audit lint
pnpm --filter @agentbase/booking-audit build       # emits dist/
```

Apache-2.0.
