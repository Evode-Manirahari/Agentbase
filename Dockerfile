FROM node:22-alpine

# Native build deps for swc/sharp/postgres-js
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

# Copy the whole monorepo (gated by .dockerignore)
COPY . .

# Install all workspace deps; @swc/core post-install runs because of
# pnpm.onlyBuiltDependencies in root package.json
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production \
    PORT=3002 \
    NODE_OPTIONS=--enable-source-maps

EXPOSE 3002

# Run the API via @swc-node/register so workspace package source files
# (which export ./src/index.ts directly) resolve without a separate build
# step. Trade-off: slightly slower cold start in exchange for not having
# to maintain a parallel dist/ for every package.
CMD ["pnpm", "--filter", "@dejavas/api", "exec", \
     "node", "--import", "@swc-node/register/esm-register", "src/main.ts"]

# Container-level health probe: hit the API's /health which already verifies
# the Postgres connection.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://localhost:3002/health | grep -q '"status":"ok"' || exit 1
