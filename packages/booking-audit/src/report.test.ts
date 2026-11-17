import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { esc, renderHtml } from './report-html.js';
import { buildFindingsJson, renderSummary, shareSummaryLine } from './report-text.js';
import type { RunMeta } from './report-text.js';
import { agent, audit, cleanCall, invoke, result, retellCall, threadCall, user } from './test-helpers.js';

const meta = (redacted = true): RunMeta => ({
  version: '0.1.0',
  generatedAt: '2026-11-16T18:00:00.000Z',
  source: 'files in ./calls',
  window: 'every call in the files',
  redacted,
});

const PHONE = '+1 (415) 555-0123';
const EMAIL = 'dana.reyes@example.com';

/** A flagged call that carries caller data in every place the report prints. */
function callWithPii(): Record<string, unknown> {
  return retellCall('call_pii', [
    user(`It's Dana, my number is ${PHONE} and my email is ${EMAIL}.`),
    invoke('a', 'Book_Appointment', { patient_name: 'Dana Reyes', phone: PHONE, when: '2026-07-09T09:45:00' }),
    agent(`You're booked for Tuesday at 9:45, I'll text ${PHONE}.`),
  ]);
}

describe('html report', () => {
  it('escapes everything a call log can contain', () => {
    const hostile = retellCall('call_<img src=x onerror=alert(1)>', [
      user('<script>alert("caller")</script>'),
      invoke('a', 'Book_Appointment<script>', { when: '</code><script>alert(1)</script>' }),
      result('a', '<iframe src="https://example.com"></iframe> timed out', false),
      agent("You're booked for Tuesday. <b onmouseover=alert(1)>hi</b>"),
    ]);
    const html = renderHtml(audit([hostile]), meta(false));
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<iframe/i);
    assert.doesNotMatch(html, /<img/i);
    assert.doesNotMatch(html, /<b onmouseover/i);
    assert.match(html, /&lt;script&gt;alert\(&quot;caller&quot;\)&lt;\/script&gt;/);
    assert.equal(esc(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
  });

  it('loads nothing from anywhere', () => {
    const html = renderHtml(audit([threadCall(), cleanCall()]), meta());
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /<link|<img|<script|@import|url\(/i);
  });

  it('masks caller data by default, in the timeline and in the quoted claim', () => {
    const html = renderHtml(audit([callWithPii()]), meta());
    assert.doesNotMatch(html, /555-0123|5550123/);
    assert.doesNotMatch(html, /dana\.reyes/);
    assert.doesNotMatch(html, /Dana Reyes/);
    // The slot is evidence and stays readable.
    assert.match(html, /2026-07-09T09:45:00/);
    assert.match(html, /Phone numbers, emails and the values of name-like arguments are masked/);
  });

  it('shows caller data only when redaction is turned off, and says so', () => {
    const html = renderHtml(audit([callWithPii()]), meta(false));
    assert.match(html, /555-0123/);
    assert.match(html, /Redaction was turned off for this run/);
  });

  it('shows the evidence for the thread failure', () => {
    const html = renderHtml(audit([threadCall()]), meta());
    assert.match(html, /F1 Repeated booking/);
    assert.match(html, /F2 Booking the caller never confirmed/);
    assert.match(html, /booking: confirmed/);
    assert.match(html, /booking: failed/);
    assert.match(html, /class="hit"/);
    // Each result names the tool call it answers.
    assert.match(html, /answers #2 · successful: true/);
    assert.match(html, /answers #6 · successful: false/);
  });

  it('puts the call with the most high findings first', () => {
    const oneHigh = retellCall('call_one_high', [user('Tuesday.'), agent("You're booked for Tuesday at 9.")], {
      start_timestamp: Date.UTC(2026, 10, 15),
    });
    const flagged = audit([oneHigh, cleanCall(), threadCall()]).flagged.map((r) => r.call.id);
    assert.deepEqual(flagged, ['call_thread', 'call_one_high']);
  });

  it('keeps two tools apart when they differ only by letter case', () => {
    const other = retellCall('c2', [invoke('a', 'book_appointment', { phone: '4155550142' }), result('a', { id: 1 }, true)]);
    const tools = audit([threadCall(), other]).bookingTools.map((t) => [t.name, t.invocations, t.identityKeys]);
    assert.deepEqual(tools, [
      ['Book_Appointment', 7, ['PatientId', 'AppointmentStartDate', 'OPId']],
      ['book_appointment', 1, ['phone']],
    ]);
  });

  it('says what a clean result does and does not mean', () => {
    const html = renderHtml(audit([cleanCall()]), meta());
    assert.match(html, /No findings in 1 calls/);
    assert.match(html, /does not mean your booking system agrees/);
  });
});

describe('text summary and findings.json', () => {
  it('prints the detected tool, the identity arguments, and a count per check', () => {
    const text = renderSummary(audit([threadCall(), cleanCall()]), meta(), '/tmp/report.html');
    assert.match(text, /Book_Appointment {2}\(8 tool calls, mcp\) {2}same booking = same PatientId, AppointmentStartDate, OPId$/m);
    assert.match(text, /Calls scanned: 2 {3}with booking attempts: 2 {3}booking attempts: 8/);
    assert.match(text, /Outcomes: 7 confirmed, 1 failed, 0 unknown/);
    assert.match(text, /F1 {2}Repeated booking\s+1 {2}\(1 high\)/);
    assert.match(text, /F3 {2}Unverified booking claim\s+0/);
    assert.match(text, /1 of 2 calls have findings\./);
    assert.match(text, /Report: \/tmp\/report\.html/);
  });

  it('the share line carries counts and nothing from any call', () => {
    const line = shareSummaryLine(audit([callWithPii(), threadCall()]), meta());
    assert.match(line, /^booking-audit 0\.1\.0 \| calls=2 attempts=8 /);
    assert.doesNotMatch(line, /call_|Dana|555|Book_Appointment/);
  });

  it('findings.json redacts the quote and keeps the detail printable', () => {
    const json = JSON.stringify(buildFindingsJson(audit([callWithPii()]), meta()));
    assert.doesNotMatch(json, /555-0123|5550123/);
    assert.match(json, /"check":"F3"/);
    const open = JSON.stringify(buildFindingsJson(audit([callWithPii()]), meta(false)));
    assert.match(open, /555-0123/);
  });

  it('names the tools it saw when it could not find a booking tool', () => {
    const call = retellCall('c', [invoke('a', 'commit_visit', { when: 't' }), result('a', { ok: true }, true)]);
    const notes = audit([call]).notes.join('\n');
    assert.match(notes, /No booking tool was detected\. Tools seen: commit_visit\./);
    assert.match(notes, /--booking-tool/);
  });

  it('says how many confirmations rest on the tool\'s word alone', () => {
    const call = retellCall('c', [
      user('Yes.'),
      invoke('a', 'Book_Appointment', { when: 't' }),
      result('a', 'Appointment booked successfully', true),
    ]);
    assert.match(audit([call]).notes.join('\n'), /1 of 1 confirmed bookings carried no appointment reference/);
  });
});
