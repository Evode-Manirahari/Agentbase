// Marketing landing page. Single page, no API, no state. Deploy target: Vercel.
//
// Every number on this page is either output of the built-in demo (made-up
// calls) or output of examples/voice-booking-repro (a mock backend), and is
// labeled as such where it appears. There are no customer numbers here because
// there are no customers. Keep it that way until that changes.

const GITHUB_URL = 'https://github.com/Evode-Manirahari/Agentbase';
const AUDIT_URL = `${GITHUB_URL}/tree/main/packages/booking-audit`;
const REPRO_URL = `${GITHUB_URL}/tree/main/examples/voice-booking-repro`;

export default function LandingPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16 sm:py-24">
      <Header />
      <Hero />
      <ReportSection />
      <ChecksSection />
      <UnknownSection />
      <TrySection />
      <ReproSection />
      <PrivacySection />
      <Footer />
    </main>
  );
}

function Header() {
  return (
    <header className="flex items-center justify-between text-sm">
      <span className="font-semibold tracking-tight">Agentbase</span>
      <nav className="flex gap-6 text-[color:var(--color-muted)]">
        <a href="#report" className="hover:text-[color:var(--color-ink)]">Report</a>
        <a href="#checks" className="hover:text-[color:var(--color-ink)]">Checks</a>
        <a href="#try" className="hover:text-[color:var(--color-ink)]">Run it</a>
        <a href={GITHUB_URL} className="hover:text-[color:var(--color-ink)]">GitHub →</a>
      </nav>
    </header>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm uppercase tracking-[0.18em] text-[color:var(--color-accent)]">{children}</p>
  );
}

function Hero() {
  return (
    <section className="mt-20 sm:mt-28">
      <Eyebrow>Booking integrity for voice agents</Eyebrow>
      <h1 className="mt-4 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
        Your voice agent said
        <br />
        {'“you’re booked.”'}
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-7 text-[color:var(--color-muted)] sm:text-xl">
        {
          'Was it? Once? A read-only audit of your call logs finds the bookings your agent sent twice, the ones the caller never agreed to, and the ones it announced with nothing behind them. It runs on your machine. Where the log cannot say what happened, it says unknown.'
        }
      </p>
      <div className="mt-8 flex flex-wrap gap-3 text-sm">
        <a
          href="#report"
          className="rounded-md bg-[color:var(--color-ink)] px-4 py-2 text-[color:var(--color-canvas)] hover:opacity-90"
        >
          See a report →
        </a>
        <a
          href="#try"
          className="rounded-md border border-[color:var(--color-edge)] px-4 py-2 hover:border-[color:var(--color-ink)]"
        >
          Run it on your calls
        </a>
        <a
          href={AUDIT_URL}
          className="rounded-md border border-[color:var(--color-edge)] px-4 py-2 hover:border-[color:var(--color-ink)]"
        >
          Read the code
        </a>
      </div>
      <p className="mt-8 max-w-2xl text-sm text-[color:var(--color-muted)]">
        Version 0.1, open source, Retell first. It is tested against fixtures shaped like the Retell
        API reference and has not yet been run on a large body of real call logs. If it gets
        something wrong on yours, tell us.
      </p>
    </section>
  );
}

const DEMO_OUTPUT = `booking-audit 0.1.0  (built-in sample calls (made up, not real data), demo)

Booking tools detected:
  Book_Appointment  (12 tool calls, mcp)  same booking = same PatientId, AppointmentStartDate, OPId
  book_appointment  (1 tool call, custom)  same booking = same phone, name, start

Calls scanned: 7   with booking attempts: 6   booking attempts: 13
Outcomes: 10 confirmed, 1 failed, 2 unknown

F1  Repeated booking                    2  (1 high, 1 low)
F2  Booking the caller never confirmed  1  (1 high)
F3  Unverified booking claim            2  (2 high)
F4  Unknown booking outcome             2  (2 medium)

5 of 7 calls have findings.
Report: ./booking-audit-demo/report.html`;

function Terminal({ command, children }: { command: string; children: string }) {
  return (
    <div className="mt-8 overflow-hidden rounded-xl border border-[color:var(--color-edge)] bg-[color:var(--color-ink)] text-sm leading-relaxed">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2 text-xs text-white/40">
        <span className="h-2 w-2 rounded-full bg-[#ff5f57]" />
        <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
        <span className="h-2 w-2 rounded-full bg-[#28c840]" />
        <span className="ml-2 font-mono">{command}</span>
      </div>
      <pre className="overflow-x-auto px-5 py-4 font-mono text-[12.5px] text-white/85">{children}</pre>
    </div>
  );
}

function ReportSection() {
  return (
    <section id="report" className="mt-24 sm:mt-32">
      <Eyebrow>What you get</Eyebrow>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        One command. A count per failure, and the evidence for each.
      </h2>
      <p className="mt-3 max-w-2xl text-[color:var(--color-muted)]">
        The terminal prints the counts. The HTML report shows each flagged call as a timeline, with
        the tool calls and sentences that are the evidence highlighted, and what to check in your
        booking system.
      </p>
      <Terminal command="booking-audit demo">{DEMO_OUTPUT}</Terminal>
      <p className="mt-3 text-xs text-[color:var(--color-muted)]">
        This is the output of the built-in demo. The calls in it are made up. One of them is modeled
        on a public report: five identical booking calls emitted in a single turn.
      </p>
    </section>
  );
}

const CHECKS = [
  {
    id: 'F1',
    title: 'Repeated booking',
    flags: 'The same booking (same tool, same person, same slot) was sent more than once in one call.',
    limit:
      'High when two or more were confirmed as different appointments. Low when your backend rejected or deduplicated the repeats.',
  },
  {
    id: 'F2',
    title: 'Booking the caller never confirmed',
    flags:
      'A second, different booking was confirmed right after an attempt went wrong, with no caller speech in between.',
    limit: 'The caller cannot have agreed to it. It does not show which booking they wanted.',
  },
  {
    id: 'F3',
    title: 'Unverified booking claim',
    flags: 'The agent said a booking was made, and no confirmed booking result came before that sentence.',
    limit: 'An unverified claim. It does not prove the appointment is missing. Only your booking system can say.',
  },
  {
    id: 'F4',
    title: 'Unknown booking outcome',
    flags:
      'A booking was sent and the log does not show whether it was made: a timeout, a server error, a bare acknowledgement, or no result at all.',
    limit: 'The appointment may exist. A timeout is not proof that nothing happened.',
  },
];

function ChecksSection() {
  return (
    <section id="checks" className="mt-24 sm:mt-32">
      <Eyebrow>Four checks</Eyebrow>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        What it flags, and what each flag does not prove.
      </h2>
      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        {CHECKS.map((check) => (
          <div key={check.id} className="rounded-xl border border-[color:var(--color-edge)] bg-white/40 p-6">
            <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-accent)]">{check.id}</p>
            <h3 className="mt-2 text-lg font-semibold tracking-tight">{check.title}</h3>
            <p className="mt-3 text-sm leading-6">{check.flags}</p>
            <p className="mt-3 text-sm leading-6 text-[color:var(--color-muted)]">{check.limit}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const READINGS: { result: string; reading: 'confirmed' | 'failed' | 'unknown'; why: string }[] = [
  { result: '{"AppointmentId": 9001}', reading: 'confirmed', why: 'The result carries an appointment reference.' },
  { result: '{"error": "Already Booked"}', reading: 'failed', why: 'An explicit rejection.' },
  { result: 'Request timed out', reading: 'unknown', why: 'The booking may have landed before the timeout.' },
  {
    result: '{"message": "Workflow was started"}',
    reading: 'unknown',
    why: 'The request arrived. That is not an appointment.',
  },
  { result: '(no result recorded)', reading: 'unknown', why: 'Nobody heard back.' },
];

function UnknownSection() {
  return (
    <section className="mt-24 sm:mt-32">
      <Eyebrow>The rule it follows</Eyebrow>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        It never upgrades an unknown to a known.
      </h2>
      <p className="mt-3 max-w-2xl text-[color:var(--color-muted)]">
        An audit that reports a timeout as a failed booking is guessing, the same way the agent
        guessed. This one reads each tool result as confirmed, failed, or unknown, and keeps the
        third one honest.
      </p>

      <div className="mt-8 overflow-hidden rounded-xl border border-[color:var(--color-edge)] bg-white/50">
        <div className="grid grid-cols-12 gap-4 border-b border-[color:var(--color-edge)] bg-white/30 px-5 py-3 text-xs uppercase tracking-wider text-[color:var(--color-muted)]">
          <div className="col-span-5">Booking tool result</div>
          <div className="col-span-2">Read as</div>
          <div className="col-span-5">Why</div>
        </div>
        {READINGS.map((row) => (
          <div
            key={row.result}
            className="grid grid-cols-12 gap-4 border-b border-[color:var(--color-edge)] px-5 py-4 text-sm last:border-b-0"
          >
            <div className="col-span-5 break-words font-mono text-xs">{row.result}</div>
            <div className="col-span-2">
              <span
                className={
                  row.reading === 'unknown'
                    ? 'rounded-full bg-[color:var(--color-accent)]/15 px-2.5 py-1 text-xs font-medium text-[color:var(--color-accent)]'
                    : 'rounded-full bg-black/5 px-2.5 py-1 text-xs font-medium'
                }
              >
                {row.reading}
              </span>
            </div>
            <div className="col-span-5 text-[color:var(--color-muted)]">{row.why}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-[color:var(--color-muted)]">
        The audit reads the call log and nothing else. Every finding ends with what to check in your
        booking system, because it cannot look there for you.
      </p>
    </section>
  );
}

const TRY_DEMO = `git clone ${GITHUB_URL} && cd Agentbase
pnpm install
pnpm --filter @agentbase/booking-audit start demo`;

const TRY_RETELL = `# The key is read from the environment, never from a flag.
RETELL_API_KEY=key_... \\
  pnpm --filter @agentbase/booking-audit start audit --retell --since 30d`;

const TRY_FILES = `# Or from call objects you already exported.
pnpm --filter @agentbase/booking-audit start audit --from ./my-calls`;

function CodeBlock({ title, body, snippet }: { title: string; body: string; snippet: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[color:var(--color-edge)] bg-white/40">
      <div className="p-6">
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        <p className="mt-2 text-sm text-[color:var(--color-muted)]">{body}</p>
      </div>
      <pre className="overflow-x-auto bg-[color:var(--color-ink)] px-6 py-4 text-xs leading-relaxed text-[color:var(--color-canvas)]">
        <code>{snippet}</code>
      </pre>
    </div>
  );
}

function TrySection() {
  return (
    <section id="try" className="mt-24 sm:mt-32">
      <Eyebrow>Run it</Eyebrow>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        Ten seconds to a sample report. A minute to your own.
      </h2>
      <p className="mt-3 max-w-2xl text-[color:var(--color-muted)]">
        It is not on npm yet, so it runs from a clone. Node 22 or newer.
      </p>
      <div className="mt-8 grid gap-6">
        <CodeBlock
          title="1. See a report"
          body="No API key and no network. Audits built-in, made-up calls and writes a real report."
          snippet={TRY_DEMO}
        />
        <CodeBlock
          title="2. Audit your own calls"
          body="Read-only requests to your own Retell account, for your own calls. Nothing is sent anywhere else."
          snippet={`${TRY_RETELL}\n\n${TRY_FILES}`}
        />
      </div>
    </section>
  );
}

const REPRO_OUTPUT = `Appointments that exist in the booking backend afterwards. The caller asked for one.

   Scenario                                     Unprotected   Through the commit protocol
1. Five identical booking calls in one turn     5             1
2. The booking lands, the response is lost      2             1
3. The caller repeats, the tool fires again     2             1`;

function ReproSection() {
  return (
    <section className="mt-24 sm:mt-32">
      <Eyebrow>What comes after the audit</Eyebrow>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        Finding it is step one. Stopping it is not built yet.
      </h2>
      <p className="mt-3 max-w-2xl text-[color:var(--color-muted)]">
        The repository also holds a commit engine: reserve the booking before sending it, record the
        attempt as unknown before it leaves, and never retry an attempt whose outcome is unknown. A
        runnable reproduction shows three public failures with and without it.
      </p>
      <Terminal command="node examples/voice-booking-repro/repro.mjs">{REPRO_OUTPUT}</Terminal>
      <p className="mt-3 max-w-2xl text-sm text-[color:var(--color-muted)]">
        <strong>The condition ships with the claim.</strong> The backend in that reproduction is a
        mock. Retrying is only safe where the backend deduplicates on a key, and an unknown is only
        settled automatically where the backend can be looked up. Where neither holds, the attempt
        stays unknown and the caller is told the truth.
      </p>
      <p className="mt-3 max-w-2xl text-sm text-[color:var(--color-muted)]">
        The endpoint that would sit in front of a real booking webhook does not exist. It gets built
        when a builder who ran the audit on real calls asks how to stop what it found.{' '}
        <a href={REPRO_URL} className="underline hover:text-[color:var(--color-ink)]">
          Read the reproduction
        </a>
        .
      </p>
    </section>
  );
}

const PRIVACY = [
  {
    title: 'Nothing is uploaded',
    body: 'No telemetry, no account, no analytics. The only network requests go to your voice platform, with your key, for your calls.',
  },
  {
    title: 'Redacted by default',
    body: 'Phone numbers, emails and name-like values are masked in the report. Slot times and appointment references stay, because they are the evidence. A name said out loud is not removed unless your platform scrubs transcripts.',
  },
  {
    title: 'Small enough to read',
    body: 'Zero runtime dependencies. Claim detection is pattern matching, not a model call, so no transcript leaves your machine. It will miss unusual phrasings.',
  },
];

function PrivacySection() {
  return (
    <section className="mt-24 sm:mt-32">
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Your call logs stay yours.</h2>
      <div className="mt-10 grid gap-6 sm:grid-cols-3">
        {PRIVACY.map((item) => (
          <div key={item.title} className="rounded-xl border border-[color:var(--color-edge)] bg-white/40 p-6">
            <h3 className="text-lg font-semibold tracking-tight">{item.title}</h3>
            <p className="mt-3 text-sm leading-6 text-[color:var(--color-muted)]">{item.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-32 border-t border-[color:var(--color-edge)] pt-8 text-sm text-[color:var(--color-muted)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>© Agentbase. Early-stage, open source, no customers yet.</span>
        <a href={GITHUB_URL} className="hover:text-[color:var(--color-ink)]">
          Evode-Manirahari/Agentbase
        </a>
      </div>
    </footer>
  );
}
