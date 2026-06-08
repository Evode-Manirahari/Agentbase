# Agentbase positioning

## Category

Agentbase is the safe-action layer for internal AI agents.

The agent-first internet needs two layers:

- Tools agents can use.
- Control planes companies can trust.

Agentbase is the control plane for internal AI agents acting across your APIs, CRM, email, and internal tools.

## One-line pitch

Scoped identity, approval, and audit for AI agents before they touch your APIs, CRM, email, and internal tools.

## What we enable

AI agents can research, enrich records, update systems of record, draft and send messages, hit internal and third-party APIs, and run multi-step workflows. Teams will not let those agents act until they have scoped permissions, approval rules, revocation, and audit trails.

Agentbase gives any internal AI agent safe, auditable permission to act.

## Buyer

Sell first into the revenue/CRM beachhead — RevOps teams deploying an agent against Salesforce/HubSpot — then expand to any team running internal agents (ops, support, internal tooling). Security and IT are required sign-off.

The deploying team owns the workflow pain:

- Agents stuck in draft-only mode because nobody trusts them to write.
- Manual copy/paste between the tools and APIs the agent should touch.
- Pilots blocked because write scopes are too broad.

Security and IT own the trust requirements:

- Agent identity.
- Scoped permissions.
- Human approval for sensitive actions.
- Revocation.
- Audit trails.

## Differentiation

Salesforce, HubSpot, Outreach, Gmail, and other vendors can govern agents inside their own products. Agentbase governs agents across the full workflow — every tool and API the agent touches, under one policy, one identity, one audit trail.

Short form: Okta + Zapier + Datadog for AI agents.

## Moat

Agentbase becomes defensible by becoming the trusted control plane for agent actions across the revenue stack.

### Trust and compliance position

RevOps and security teams need proof before letting agents touch CRM, email, and sales tools. Agentbase should become the approval and audit source of truth: every agent identity, permission, policy decision, approval, denial, connector result, revocation, and exportable audit event lives in one system security can inspect.

### Cross-stack integration depth

Each revenue platform has its own permissions and logs. Agentbase's advantage is governing the whole workflow across Salesforce, HubSpot, Gmail, Outreach, Slack, Apollo, and future revenue-stack tools instead of governing one app at a time.

### Embedded switching cost

Once agent identities, scoped API keys, policies, approvals, logs, connector credentials, and audit exports live in Agentbase, replacing it means rebuilding the trust layer around every production agent workflow.

### Agent-native interface

The buyer is human, but the daily user is the agent. SDK and MCP access let agents call Agentbase directly while humans keep control over identity, policy, approvals, and audit.

### Action history data

As customers use Agentbase, the action history becomes a compounding asset: which tools are risky, which policies work, which approvals are common, which agents need tighter scopes, and which guardrails security accepts. That data can become policy recommendations and better default controls over time.

## Product thesis

Agentbase is not a single AI SDR. The bundled outbound, follow-up, reply-handler, CRM hygiene, and lead-list flows are a frozen reference implementation — proof the gate works on a real agent, not the product.

Every internal-agent workflow should pass through the same primitives:

- Agent identity.
- Policy decision.
- Approval routing.
- Connector execution.
- Revocation.
- Audit and monitoring.
