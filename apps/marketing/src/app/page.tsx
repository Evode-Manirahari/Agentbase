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
      <DemoSection />
      <Pillars />
      <BringYourOwnAgent />
      <Footer />
    </main>
  );
}

function Header() {
  return (
    <header className="flex items-center justify-between text-sm">
      <span className="font-semibold tracking-tight">Agentbase</span>
      <nav className="flex gap-6 text-[color:var(--color-muted)]">
        <a href="#demo" className="hover:text-[color:var(--color-ink)]">Demo</a>
        <a href="#how" className="hover:text-[color:var(--color-ink)]">How it works</a>
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
          href="#demo"
          className="rounded-md bg-[color:var(--color-ink)] px-4 py-2 text-[color:var(--color-canvas)] hover:opacity-90"
        >
          Watch the demo →
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
  return (
    <section id="demo" className="mt-24 sm:mt-32">
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        One policy file. Two CRMs. Same approval queue.
      </h2>
      <p className="mt-3 max-w-2xl text-[color:var(--color-muted)]">
        Watch a single agent run writes across HubSpot and Salesforce
        through one Agentbase policy — then watch Claude Desktop do the
        same writes through MCP. Same gate, same audit log, two
        integration surfaces.
      </p>

      <div className="mt-8 aspect-video w-full overflow-hidden rounded-xl border border-[color:var(--color-edge)] bg-black">
        {LOOM_EMBED_ID ? (
          <iframe
            src={`https://www.loom.com/embed/${LOOM_EMBED_ID}`}
            title="Agentbase cross-stack demo"
            allow="fullscreen"
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[color:var(--color-ink)] text-sm text-[color:var(--color-canvas)]/60">
            Demo recording lands here. Paste the Loom share-code into
            <code className="ml-1 rounded bg-white/10 px-2 py-0.5">LOOM_EMBED_ID</code>
            in <code className="ml-1 rounded bg-white/10 px-2 py-0.5">app/page.tsx</code>.
          </div>
        )}
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
    <section className="mt-24 sm:mt-32">
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
