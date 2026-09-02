# Shared image for the three Node services (helixid-setup, mcp-server, agent).
# They live in one workspace package and differ only by which entrypoint runs,
# so compose overrides the command per service.
#
# Build context: the parent directory containing all four split repos (see
# docker-compose.yml's `context: ../../..`). This example's package.json
# already points @helixid/sdk-js and @helixid/mcp at
# "file:../../../helix-sdk-js/<pkg>" (the real on-disk sibling-repo layout),
# so as long as we preserve that same relative structure inside the image,
# no dependency rewriting is needed here (unlike e2e-consent-demo, which
# still uses a git dependency on the currently-private helix-sdk-js repo —
# see that example's node.Dockerfile for why).
#
#   docker build -f helix-server/examples/e2e-travel-concierge/docker/node.Dockerfile -t helixid-v2-node .
FROM node:24.15.0-alpine
RUN corepack enable
# Prefer IPv4 for package downloads (some Docker VM networks have flaky IPv6).
ENV NODE_OPTIONS=--dns-result-order=ipv4first
WORKDIR /repo

# Manifests first for layer caching, then the sources this example builds against.
COPY helix-server/pnpm-workspace.yaml helix-server/package.json helix-server/pnpm-lock.yaml helix-server/tsconfig.base.json helix-server/
COPY helix-server/examples/e2e-travel-concierge helix-server/examples/e2e-travel-concierge

# Vendored, pre-built sibling packages (built via `pnpm --filter @helixid/sdk-js
# build` / `pnpm --filter @helixid/mcp build` in the helix-sdk-js repo). Only
# dist/ + package.json are needed -- consumers resolve via "main"/"exports".
COPY helix-sdk-js/helix-sdk-js/dist helix-sdk-js/helix-sdk-js/dist
COPY helix-sdk-js/helix-sdk-js/package.json helix-sdk-js/helix-sdk-js/package.json
COPY helix-sdk-js/mcp/dist helix-sdk-js/mcp/dist
COPY helix-sdk-js/mcp/package.json helix-sdk-js/mcp/package.json

# Drop "scripts" (notably "prepare": "npm run build") from the vendored
# package.jsons -- dist/ is already built, and there's no src/ or
# devDependencies here for a rebuild to work against. Also repoint
# @helixid/mcp's own "@helixid/sdk-js": "link:../helix-sdk-js" at an
# absolute path: pnpm resolves that *nested* relative link one directory too
# shallow when @helixid/mcp itself is installed via a relative `file:` spec
# (real bug hit this session -- it landed on /repo/helix-sdk-js instead of
# /repo/helix-sdk-js/helix-sdk-js, so mcp-server couldn't find sdk-js at
# runtime: "Cannot find package '.../@helixid/sdk-js/index.js'").
RUN node -e "for (const p of ['helix-sdk-js/helix-sdk-js', 'helix-sdk-js/mcp']) { const f = p + '/package.json'; const j = require('./' + f); delete j.scripts; require('fs').writeFileSync(f, JSON.stringify(j, null, 2)); }" \
 && npm pkg set "dependencies.@helixid/sdk-js=file:/repo/helix-sdk-js/helix-sdk-js" --prefix helix-sdk-js/mcp

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    --mount=type=cache,target=/root/.cache/node \
    cd helix-server && pnpm install --no-frozen-lockfile \
  --filter @helixid/example-e2e-travel-concierge

WORKDIR /repo/helix-server/examples/e2e-travel-concierge
# Default command; docker-compose overrides it with `pnpm setup|mcp|agent`.
CMD ["pnpm", "run", "agent"]
