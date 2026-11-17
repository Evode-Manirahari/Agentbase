import type { AuditResult, CallReport } from './audit.js';
import { redactMaybeJson, redactText } from './redact.js';
import type { RunMeta } from './report-text.js';
import type { BookingAttempt, CallEvent, CheckId, Finding, Severity } from './types.js';
import { CHECK_TITLES, SEVERITY_RANK } from './types.js';

// One self-contained file. No scripts, no fonts, no images, no requests. The
// Content-Security-Policy below makes that a property of the document rather
// than a promise: a browser will refuse to load anything from it.
//
// Everything in a call log is untrusted text that ends up inside HTML, so every
// value goes through esc(). There is no innerHTML-shaped shortcut in this file.

const MAX_TIMELINE_ROWS = 400;
const MAX_RESULT_CHARS = 600;
const MAX_CALLS_RENDERED = 200;

export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CHECK_MEANING: Record<CheckId, { means: string; notProof: string }> = {
  F1: {
    means: 'The same booking (same tool, same person, same slot) was sent more than once in one call.',
    notProof:
      'High when two or more were confirmed as different appointments. Low when your backend rejected or deduplicated the repeats.',
  },
  F2: {
    means:
      'A second, different booking was confirmed right after a booking attempt went wrong, with no caller speech in between.',
    notProof: 'The caller cannot have agreed to it. It does not show which booking the caller wanted.',
  },
  F3: {
    means: 'The agent told the caller a booking was made, and no confirmed booking result came before that sentence.',
    notProof: 'An unverified claim. It does not prove the appointment is missing. Only your booking system can say.',
  },
  F4: {
    means:
      'A booking was sent and the log does not show whether it was made: a timeout, a server error, a bare acknowledgement, or no result at all.',
    notProof: 'The appointment may exist. A timeout is not proof that nothing happened.',
  },
};

const CHECK_ORDER: CheckId[] = ['F1', 'F2', 'F3', 'F4'];
const SEVERITIES: Severity[] = ['high', 'medium', 'low'];

const CSS = `
:root{--bg:#fbfaf8;--fg:#1c1b19;--muted:#6b6862;--line:#e3e0da;--card:#ffffff;--high:#b3261e;--high-bg:#fbe9e7;--medium:#8a5a00;--medium-bg:#fff3d6;--low:#3d5a80;--low-bg:#e6eef7;--ok:#2e6b3f;--mark:#fff8e1;--code:#f3f1ec}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#ebe8e2;--muted:#a09c94;--line:#33312d;--card:#1f1e1b;--high:#ff8a80;--high-bg:#3a1c1a;--medium:#ffc766;--medium-bg:#3a2e12;--low:#9cc2ec;--low-bg:#1b2a3a;--ok:#8fd19e;--mark:#2f2a17;--code:#262521}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:28px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:18px;margin:36px 0 12px}
p{margin:8px 0}
.sub{color:var(--muted);font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card b{display:block;font-size:26px;line-height:1.2;font-variant-numeric:tabular-nums}
.card span{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;vertical-align:top;padding:9px 12px;border-bottom:1px solid var(--line);font-size:14px}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
td.n{font-variant-numeric:tabular-nums;white-space:nowrap}
.wrap{overflow-x:auto}
.badge{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;white-space:nowrap}
.badge.high{color:var(--high);background:var(--high-bg)}
.badge.medium{color:var(--medium);background:var(--medium-bg)}
.badge.low{color:var(--low);background:var(--low-bg)}
.confirmed{color:var(--ok)}
.failed{color:var(--high)}
.unknown{color:var(--medium)}
details{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:12px 0}
summary{cursor:pointer;padding:12px 16px;font-weight:600;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
summary .id{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:500}
.body{padding:0 16px 16px}
.finding{border-left:3px solid var(--line);padding:2px 0 2px 12px;margin:14px 0}
.finding.high{border-left-color:var(--high)}
.finding.medium{border-left-color:var(--medium)}
.finding.low{border-left-color:var(--low)}
.finding h3{font-size:15px;margin:0 0 4px}
blockquote{margin:6px 0;padding:6px 12px;background:var(--code);border-radius:6px;font-style:italic}
.check{color:var(--muted);font-size:13px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}
tr.hit td{background:var(--mark)}
td.who{white-space:nowrap;color:var(--muted);font-size:13px}
ul{margin:8px 0;padding-left:20px}
footer{margin-top:40px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:16px}
`;

function severityBadges(findings: Finding[]): string {
  return SEVERITIES.map((s) => {
    const n = findings.filter((f) => f.severity === s).length;
    return n > 0 ? `<span class="badge ${s}">${n} ${s}</span>` : '';
  }).join(' ');
}

function eventRow(
  event: CallEvent,
  attemptsByIndex: Map<number, BookingAttempt>,
  invocationIndexById: Map<string, number>,
  hits: Set<number>,
  redacted: boolean,
): string {
  let who: string;
  let body: string;

  if (event.kind === 'utterance') {
    who = event.speaker === 'agent' ? 'Agent' : event.speaker === 'user' ? 'Caller' : 'Other';
    body = esc(redacted ? redactText(event.text) : event.text);
  } else if (event.kind === 'tool_invocation') {
    who = 'Tool call';
    const args = redacted ? redactMaybeJson(event.rawArguments) : event.rawArguments;
    const attempt = attemptsByIndex.get(event.index);
    const tone = attempt?.outcome === 'confirmed' ? 'low' : attempt?.outcome === 'failed' ? 'high' : 'medium';
    const outcome = attempt
      ? ` <span class="badge ${tone}">booking: ${attempt.outcome}</span><div class="check">${esc(attempt.outcomeReason)}</div>`
      : '';
    body = `<code>${esc(event.name)}(${esc(args)})</code>${outcome}`;
  } else if (event.kind === 'tool_result') {
    who = 'Tool result';
    const raw = redacted ? redactMaybeJson(event.content) : event.content;
    const text = raw.length > MAX_RESULT_CHARS ? `${raw.slice(0, MAX_RESULT_CHARS)} ... (truncated)` : raw;
    const flag = event.successful === null ? 'not stated' : String(event.successful);
    // Five results after five calls are unreadable without knowing which is which.
    const answers = invocationIndexById.get(event.toolCallId);
    const pairing = answers === undefined ? '' : `answers #${answers} · `;
    body = `<code>${esc(text === '' ? '(empty)' : text)}</code><div class="check">${pairing}successful: ${flag}</div>`;
  } else {
    who = 'Event';
    body = `<span class="check">${esc(event.label)}</span>`;
  }

  const phase = event.phase === 'call' ? '' : ` <span class="check">(${event.phase}-call)</span>`;
  const hit = hits.has(event.index) ? ' class="hit"' : '';
  return `<tr${hit}><td class="n">${event.index}</td><td class="who">${who}${phase}</td><td>${body}</td></tr>`;
}

function callSection(report: CallReport, redacted: boolean, open: boolean): string {
  const { call, attempts, findings } = report;
  const hits = new Set(findings.flatMap((f) => f.eventIndexes));
  const attemptsByIndex = new Map(attempts.map((a) => [a.invocation.index, a]));
  const invocationIndexById = new Map<string, number>();
  for (const e of call.events) {
    if (e.kind === 'tool_invocation' && !invocationIndexById.has(e.toolCallId)) invocationIndexById.set(e.toolCallId, e.index);
  }
  const when =
    call.startedAt === null ? 'time not recorded' : new Date(call.startedAt).toISOString().replace('.000Z', 'Z');
  const agent = call.agentName ?? call.agentId ?? 'unknown agent';
  const version = call.agentVersion === null ? '' : ` v${call.agentVersion}`;

  const sorted = [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const findingHtml = sorted
    .map((f) => {
      const quote =
        f.quote === null ? '' : `<blockquote>${esc(redacted ? redactText(f.quote) : f.quote)}</blockquote>`;
      return `<div class="finding ${f.severity}">
<h3>${f.check} ${esc(f.title)} <span class="badge ${f.severity}">${f.severity}</span></h3>
<p>${esc(f.detail)}</p>
${quote}
<p class="check"><b>Check in your booking system:</b> ${esc(f.whatToCheck)}</p>
</div>`;
    })
    .join('\n');

  const events = call.events.slice(0, MAX_TIMELINE_ROWS);
  const cut =
    call.events.length > MAX_TIMELINE_ROWS
      ? `<p class="check">Timeline cut at ${MAX_TIMELINE_ROWS} of ${call.events.length} rows.</p>`
      : '';

  return `<details${open ? ' open' : ''}>
<summary>${severityBadges(findings)} <span class="id">${esc(call.id)}</span> <span class="sub">${esc(when)} · ${esc(agent)}${esc(version)}</span></summary>
<div class="body">
${findingHtml}
<div class="wrap"><table>
<thead><tr><th>#</th><th>Who</th><th>What happened (highlighted rows are the evidence)</th></tr></thead>
<tbody>
${events.map((e) => eventRow(e, attemptsByIndex, invocationIndexById, hits, redacted)).join('\n')}
</tbody></table></div>
${cut}
</div>
</details>`;
}

export function renderHtml(result: AuditResult, meta: RunMeta): string {
  const t = result.totals;
  const checkRows = CHECK_ORDER.map((c) => {
    const n = t.byCheck[c];
    const meaning = CHECK_MEANING[c];
    return `<tr><td><b>${c}</b> ${esc(CHECK_TITLES[c])}</td><td>${esc(meaning.means)}<div class="check">${esc(meaning.notProof)}</div></td><td class="n">${n.high}</td><td class="n">${n.medium}</td><td class="n">${n.low}</td></tr>`;
  }).join('\n');

  const toolRows =
    result.bookingTools.length === 0
      ? '<tr><td colspan="4">No booking tool was detected.</td></tr>'
      : result.bookingTools
          .map((tool) => {
            const identity = tool.identityKeys.join(', ') || '(no arguments)';
            return `<tr><td><code>${esc(tool.name)}</code></td><td>${esc(tool.type ?? 'not stated')}</td><td class="n">${tool.invocations}</td><td><code>${esc(identity)}</code></td></tr>`;
          })
          .join('\n');

  const notes =
    result.notes.length === 0
      ? ''
      : `<h2>Notes</h2><ul>${result.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;

  const rendered = result.flagged.slice(0, MAX_CALLS_RENDERED);
  const overflow =
    result.flagged.length > MAX_CALLS_RENDERED
      ? `<p class="check">Showing the ${MAX_CALLS_RENDERED} worst of ${result.flagged.length} flagged calls. findings.json has all of them.</p>`
      : '';
  const flagged =
    result.flagged.length === 0
      ? `<p>No findings in ${t.callsScanned} calls. The log shows no repeated, unconfirmed, unverified or unknown bookings. That does not mean your booking system agrees with the log.</p>`
      : rendered.map((r, i) => callSection(r, meta.redacted, i < 3)).join('\n') + overflow;

  const privacy = meta.redacted
    ? 'Phone numbers, emails and the values of name-like arguments are masked. A name somebody said out loud is not removed unless your platform scrubs transcripts.'
    : 'Redaction was turned off for this run. This file contains unmasked caller data.';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="referrer" content="no-referrer">
<title>Booking audit</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>Booking audit</h1>
<p class="sub">${esc(meta.source)} · ${esc(meta.window)} · generated ${esc(meta.generatedAt)} · booking-audit ${esc(meta.version)}</p>

<div class="cards">
<div class="card"><b>${t.callsScanned}</b><span>calls scanned</span></div>
<div class="card"><b>${t.callsWithBookingAttempts}</b><span>calls with a booking attempt</span></div>
<div class="card"><b>${t.bookingAttempts}</b><span>booking attempts</span></div>
<div class="card"><b>${t.flaggedCalls}</b><span>calls with findings</span></div>
</div>
<p class="sub">Outcomes read from the log: <span class="confirmed">${t.confirmed} confirmed</span>, <span class="failed">${t.failed} failed</span>, <span class="unknown">${t.unknown} unknown</span>.</p>

<h2>What was checked</h2>
<div class="wrap"><table>
<thead><tr><th>Check</th><th>What it means, and what it does not prove</th><th>High</th><th>Medium</th><th>Low</th></tr></thead>
<tbody>
${checkRows}
</tbody></table></div>

<h2>Booking tools detected</h2>
<p class="sub">Two calls to a tool count as the same booking when these arguments match. If a tool is missing or wrong here, rerun with <code>--booking-tool</code> or <code>--identity</code>.</p>
<div class="wrap"><table>
<thead><tr><th>Tool</th><th>Type</th><th>Tool calls</th><th>Same booking = same</th></tr></thead>
<tbody>
${toolRows}
</tbody></table></div>
${notes}

<h2>Calls with findings</h2>
${flagged}

<footer>
<p><b>What this audit cannot see.</b> It reads the call log and nothing else. It does not look inside your booking system, so every finding ends with what to check there. Bookings created after the call by a separate automation are invisible to it unless the platform logs them as post-call tool calls.</p>
<p><b>Privacy.</b> This file was generated on your machine and loads nothing from the network. ${privacy}</p>
</footer>
</main>
</body>
</html>
`;
}
