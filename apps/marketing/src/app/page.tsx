// Marketing landing page. Single page, no API, no state. Deploy target: Vercel.
//
// After recording the Loom: replace LOOM_EMBED_ID below with the share-code
// from the Loom URL (the segment after `/share/` or `/embed/`).
const LOOM_EMBED_ID: string | null = null;

const GITHUB_URL = 'https://github.com/Evode-Manirahari/Agentbase';

export default function LandingPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16 sm:py-24">
      <Header />
      <Hero />
      <GateFireSection />
      <ApprovalQueueSection />
      <PolicySection />
      <DemoSection />
      <Pillars />
      <BringYourOwnAgent />
      <Footer />
    </main>
  );
}

function GateFireSection() {
  return (
    <section id="proof" className="mt-24 sm:mt-32">
      <p className="text-sm uppercase tracking-[0.18em] text-[color:var(--color-accent)]">
        Proof — actual run
      </p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        Watch the gate fire on a single cross-stack run.
      </h2>
      <p className="mt-3 max-w-2xl text-[color:var(--color-muted)]">
        One agent identity. Eight tool calls. Six allowed, two paused
        for human approval — one HubSpot, one Salesforce, same rule,
        same queue.
      </p>

      <div className="mt-8 overflow-hidden rounded-xl border border-[color:var(--color-edge)] bg-[color:var(--color-ink)] text-sm leading-relaxed">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2 text-xs text-white/40">
          <span className="h-2 w-2 rounded-full bg-[#ff5f57]" />
          <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
          <span className="h-2 w-2 rounded-full bg-[#28c840]" />
          <span className="ml-2">pnpm --filter &apos;@agentbase/cross-stack-demo&apos; run start</span>
        </div>
        <pre className="overflow-x-auto px-5 py-4 font-mono text-[12.5px] text-white/85">
          <ConsoleOutput />
        </pre>
      </div>
    </section>
  );
}

function ConsoleOutput() {
  return (
    <>
      <span className="block text-white/55">🤖 cross-stack-demo — one agent, one policy, two CRMs</span>
      <span className="block text-white/40">   lead:   cto@globex.com</span>
      <span className="block text-white/40">   policy: high-value writes ($25k+) → #critical-approvals</span>
      <span className="block">{' '}</span>

      <ConsoleStep
        label="[hubspot] Mirror contact into HubSpot CRM"
        tool="hubspot.contacts.upsert"
        status="allow"
        reason='matched rule[3]: hubspot.contacts.upsert'
      />
      <ConsoleStep
        label="[salesforce] Mirror contact into Salesforce CRM"
        tool="salesforce.contact.create"
        status="allow"
        reason='matched rule[13]: salesforce.contact.create'
      />
      <ConsoleStep
        label="[salesforce] Open $8k Salesforce opportunity"
        tool="salesforce.opportunity.create"
        status="allow"
        reason='matched rule[19]: salesforce.opportunity.create'
      />
      <ConsoleStep
        label="[salesforce] Open $80k Salesforce opportunity — gated"
        tool="salesforce.opportunity.create"
        status="awaiting_approval"
        reason='high-value Salesforce opportunity'
      />
      <ConsoleStep
        label="[gmail] Draft outreach email in Gmail"
        tool="gmail.draft.create"
        status="allow"
        reason='drafts never leave the outbox without a human'
      />
      <ConsoleStep
        label="[hubspot] Bump HubSpot deal to $60k — gated"
        tool="hubspot.deals.update"
        status="awaiting_approval"
        reason='high-value HubSpot deal change'
      />

      <span className="block">{' '}</span>
      <span className="block text-white/55">🤖 cross-stack-demo — done.</span>
      <span className="block">{' '}</span>
      <span className="block text-white/40">   · one agent identity issued the writes to BOTH CRMs</span>
      <span className="block text-white/40">   · one policy.yaml governed every call</span>
      <span className="block text-white/40">   · both high-value steps routed to the same queue</span>
    </>
  );
}

function ConsoleStep({
  label,
  tool,
  status,
  reason,
}: {
  label: string;
  tool: string;
  status: 'allow' | 'awaiting_approval';
  reason: string;
}) {
  const isGated = status === 'awaiting_approval';
  return (
    <>
      <span className="block text-white/75">→ {label}</span>
      <span className="block pl-3 text-white/55">{tool}</span>
      {isGated ? (
        <span className="block pl-3 font-semibold text-[#ffb38a]">
          🛂 awaiting_approval{'  '}
          <span className="font-normal text-[#ffb38a]/70">policy: require_approval — &quot;{reason}&quot;</span>
        </span>
      ) : (
        <span className="block pl-3 text-white/55">
          ✓ policy: allow{'  '}
          <span className="text-white/40">— &quot;{reason}&quot;</span>
        </span>
      )}
      <span className="block">{' '}</span>
    </>
  );
}

function ApprovalQueueSection() {
  return (
    <section className="mt-24 sm:mt-32">
      <p className="text-sm uppercase tracking-[0.18em] text-[color:var(--color-accent)]">
        Same queue, different vendors
      </p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        Two CRMs landed in one approval inbox.
      </h2>
      <p className="mt-3 max-w-2xl text-[color:var(--color-muted)]">
        Both pending rows trace back to the same `<code className="rounded bg-white/40 px-1.5 py-0.5 text-sm">Amount ≥ 25000</code>`
        rule. Approver sees one queue, regardless of which vendor the
        agent reached for.
      </p>

      <div className="mt-8 overflow-hidden rounded-xl border border-[color:var(--color-edge)] bg-white/50">
        <div className="grid grid-cols-12 gap-4 border-b border-[color:var(--color-edge)] bg-white/30 px-5 py-3 text-xs uppercase tracking-wider text-[color:var(--color-muted)]">
          <div className="col-span-3">Tool</div>
          <div className="col-span-5">Why gated</div>
          <div className="col-span-2">Amount</div>
          <div className="col-span-2">Status</div>
        </div>

        <ApprovalRow
          vendor="Salesforce"
          tool="opportunity.create"
          reason="high-value Salesforce opportunity"
          amount="$80,000"
        />
        <ApprovalRow
          vendor="HubSpot"
          tool="deals.update"
          reason="high-value HubSpot deal change"
          amount="$60,000"
        />
      </div>
      <p className="mt-3 text-xs text-[color:var(--color-muted)]">
        Decisions route to Slack <code>#critical-approvals</code> and the
        web inbox at <code>/approvals</code>. Every action lands in the
        audit log either way.
      </p>
    </section>
  );
}

function ApprovalRow({
  vendor,
  tool,
  reason,
  amount,
}: {
  vendor: string;
  tool: string;
  reason: string;
  amount: string;
}) {
  return (
    <div className="grid grid-cols-12 gap-4 border-b border-[color:var(--color-edge)] px-5 py-4 text-sm last:border-b-0">
      <div className="col-span-3">
        <div className="font-medium">{vendor}</div>
        <div className="font-mono text-xs text-[color:var(--color-muted)]">{tool}</div>
      </div>
      <div className="col-span-5 text-[color:var(--color-muted)]">{reason}</div>
      <div className="col-span-2 font-medium">{amount}</div>
      <div className="col-span-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-accent)]/15 px-2.5 py-1 text-xs font-medium text-[color:var(--color-accent)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-accent)]" />
          pending
        </span>
      </div>
    </div>
  );
}

function PolicySection() {
  return (
    <section className="mt-24 sm:mt-32">
      <p className="text-sm uppercase tracking-[0.18em] text-[color:var(--color-accent)]">
        The rule
      </p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        One policy file. Same shape across vendors.
      </h2>
      <p className="mt-3 max-w-2xl text-[color:var(--color-muted)]">
        Salesforce alone, HubSpot alone, or both — the rule is the same.
        Switching CRMs costs one extra line in <code>policy.yaml</code>,
        not a new governance product.
      </p>

      <pre className="mt-8 overflow-x-auto rounded-xl border border-[color:var(--color-edge)] bg-[color:var(--color-ink)] px-5 py-4 text-xs leading-relaxed text-[color:var(--color-canvas)]">
        <code>{`- match: { tool: 'salesforce.opportunity.create',
           when: { fields.Amount: { gte: 25000 } } }
  effect: require_approval
  slack_channel: '#critical-approvals'

- match: { tool: 'hubspot.deals.update',
           when: { properties.amount: { gte: 25000 } } }
  effect: require_approval
  slack_channel: '#critical-approvals'`}</code>
      </pre>
    </section>
  );
}

function Header() {
  return (
    <header className="flex items-center justify-between text-sm">
      <span className="font-semibold tracking-tight">Agentbase</span>
      <nav className="flex gap-6 text-[color:var(--color-muted)]">
        <a href="#proof" className="hover:text-[color:var(--color-ink)]">Proof</a>
        <a href="#how" className="hover:text-[color:var(--color-ink)]">How it works</a>
        <a href="#integrate" className="hover:text-[color:var(--color-ink)]">Integrate</a>
        <a href={GITHUB_URL} className="hover:text-[color:var(--color-ink)]">GitHub →</a>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section className="mt-20 sm:mt-28">
      <p className="text-sm uppercase tracking-[0.18em] text-[color:var(--color-accent)]">
        The control plane for AI sales agents
      </p>
      <h1 className="mt-4 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
        The secure action layer
        <br />
        for AI sales agents.
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-7 text-[color:var(--color-muted)] sm:text-xl">
        Cross-stack governance for revenue agents before they touch CRM,
        email, and sales tools. One policy, every connector — across
        HubSpot, Salesforce, Gmail, Outreach, and Apollo.
      </p>
      <div className="mt-8 flex flex-wrap gap-3 text-sm">
        <a
          href="#proof"
          className="rounded-md bg-[color:var(--color-ink)] px-4 py-2 text-[color:var(--color-canvas)] hover:opacity-90"
        >
          See the gate fire →
        </a>
        <a
          href={GITHUB_URL}
          className="rounded-md border border-[color:var(--color-edge)] px-4 py-2 hover:border-[color:var(--color-ink)]"
        >
          See the code
        </a>
      </div>
      <p className="mt-8 text-sm italic text-[color:var(--color-muted)]">
        Okta + Zapier + Datadog for AI sales agents.
      </p>
    </section>
  );
}

function DemoSection() {
  if (!LOOM_EMBED_ID) return null;
  return (
    <section id="demo" className="mt-24 sm:mt-32">
      <p className="text-sm uppercase tracking-[0.18em] text-[color:var(--color-accent)]">
        Watch it live
      </p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        Same flow, narrated end-to-end.
      </h2>
      <p className="mt-3 max-w-2xl text-[color:var(--color-muted)]">
        Five-minute walkthrough: the SDK runs the cross-stack flow,
        Claude Desktop runs the same writes through MCP, both land in
        the same approval queue and audit log.
      </p>

      <div className="mt-8 aspect-video w-full overflow-hidden rounded-xl border border-[color:var(--color-edge)] bg-black">
        <iframe
          src={`https://www.loom.com/embed/${LOOM_EMBED_ID}`}
          title="Agentbase cross-stack demo"
          allow="fullscreen"
          className="h-full w-full"
        />
      </div>
    </section>
  );
}

function Pillars() {
  return (
    <section id="how" className="mt-24 sm:mt-32">
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        The three things every revenue agent needs before it touches
        production systems.
      </h2>
      <div className="mt-10 grid gap-6 sm:grid-cols-3">
        <Pillar
          eyebrow="Identity"
          title="Okta for agents"
          body="Every agent gets a scoped identity, an agb_… token, and per-tool permission profiles. Revoke a compromised agent in one click."
        />
        <Pillar
          eyebrow="Action layer"
          title="Zapier with a policy"
          body="One YAML policy decides allow / require_approval / deny per tool, agent, and condition — the same rule shape covers HubSpot, Salesforce, Gmail, Outreach, Apollo."
        />
        <Pillar
          eyebrow="Monitoring + audit"
          title="Datadog for actions"
          body="Slack and web approval routing, immutable audit log, CSV / JSON export for SOC 2 questionnaires, dashboards on approval rate, deny rate, top policy hits, actions/day per agent."
        />
      </div>
    </section>
  );
}

function Pillar({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-[color:var(--color-edge)] bg-white/40 p-6">
      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-accent)]">
        {eyebrow}
      </p>
      <h3 className="mt-2 text-lg font-semibold tracking-tight">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-[color:var(--color-muted)]">
        {body}
      </p>
    </div>
  );
}

function BringYourOwnAgent() {
  return (
    <section id="integrate" className="mt-24 sm:mt-32">
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        Two ways to plug your agent in.
      </h2>
      <p className="mt-3 max-w-2xl text-[color:var(--color-muted)]">
        Code-level integration for your own agent loop, or protocol-level
        for any MCP-aware client. Both land in the same gate.
      </p>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <CodeCard
          eyebrow="Code-level"
          title="@agentbase/sdk"
          body="LangChain, Vercel AI, Mastra, raw Anthropic — anything that can make HTTP."
          snippet={`import { AgentbaseClient } from '@agentbase/sdk';

const agentbase = new AgentbaseClient({
  apiKey: process.env.AGENTBASE_API_KEY,
});

await agentbase.executeAndWait({
  tool: 'gmail.send',
  params: { to: 'cto@globex.com', subject: '…', body: '…' },
});`}
        />
        <CodeCard
          eyebrow="Protocol-level"
          title="@agentbase/mcp-server"
          body="Claude Desktop, Cursor, Codex, any MCP-aware client. Drop one block in your config."
          snippet={`{
  "mcpServers": {
    "agentbase": {
      "command": "node",
      "args": ["/path/to/agentbase-mcp"],
      "env": {
        "AGENTBASE_API_KEY": "agb_…"
      }
    }
  }
}`}
        />
      </div>
    </section>
  );
}

function CodeCard({
  eyebrow,
  title,
  body,
  snippet,
}: {
  eyebrow: string;
  title: string;
  body: string;
  snippet: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[color:var(--color-edge)] bg-white/40">
      <div className="p-6">
        <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-accent)]">
          {eyebrow}
        </p>
        <h3 className="mt-2 text-lg font-semibold tracking-tight">{title}</h3>
        <p className="mt-2 text-sm text-[color:var(--color-muted)]">{body}</p>
      </div>
      <pre className="overflow-x-auto bg-[color:var(--color-ink)] px-6 py-4 text-xs leading-relaxed text-[color:var(--color-canvas)]">
        <code>{snippet}</code>
      </pre>
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-32 border-t border-[color:var(--color-edge)] pt-8 text-sm text-[color:var(--color-muted)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>© Agentbase. Early — no customers yet.</span>
        <a href={GITHUB_URL} className="hover:text-[color:var(--color-ink)]">
          Evode-Manirahari/Agentbase
        </a>
      </div>
    </footer>
  );
}
