FROM node:22-alpine

RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

# Build context is the repo root so we get all workspace packages
COPY . .

RUN pnpm install --frozen-lockfile

# Build the Next.js app (compiles server components + client bundle)
RUN pnpm --filter '@agentbase/web' run build

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

EXPOSE 3000

# next start serves the .next/ build on $PORT
CMD ["pnpm", "--filter", "@agentbase/web", "run", "start"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000 | grep -q 'Agentbase' || exit 1
