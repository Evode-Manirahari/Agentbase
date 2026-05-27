# @agentbase/marketing

Standalone marketing landing page for Agentbase. No API, no DB — just one
page deployable to Vercel as a temporary buyer-facing destination.

## Local

```bash
pnpm --filter @agentbase/marketing dev
# → http://localhost:3001
```

## Deploy to Vercel

The page builds as a static Next.js app and deploys cleanly:

```bash
# from the repo root
vercel deploy --cwd apps/marketing
```

Or wire up the GitHub repo in the Vercel dashboard and set:

- **Root Directory:** `apps/marketing`
- **Framework Preset:** Next.js (auto-detected)
- **Install Command:** `pnpm install --frozen-lockfile`
- **Build Command:** `pnpm --filter @agentbase/marketing build`

No env vars required.

## After recording the Loom

Open `src/app/page.tsx`, find:

```ts
const LOOM_EMBED_ID: string | null = null;
```

Paste your Loom share-code (the segment after `/share/` in the Loom URL —
e.g. for `https://www.loom.com/share/abc123def456`, the code is
`abc123def456`). Commit, push, and Vercel rebuilds the live page.
