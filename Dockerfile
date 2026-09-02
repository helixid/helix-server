# helix-api production image.
#
# Ported from the pre-split monorepo's root Dockerfile. That version COPYed
# in local helix-core/helix-sdk-js/packages/did-hedera workspace packages
# that no longer live in this repo (they moved to the separate helix-sdk-js
# repo when the monorepo was split; @helixid/core was retired and its logic
# duplicated inline into helix-api's own src/core/). @helixid/did-hedera is
# declared as a pnpm git dependency (github:helixid/helix-sdk-js#path:did-hedera,
# see pnpm-workspace.yaml's allowBuilds), but that repo is currently *private*
# -- this image has no git credentials for it, so a plain `pnpm install`
# can't fetch it here (the same reason each example's node.Dockerfile
# vendors its sibling packages instead of installing them from git).
#
# TODO(helixid/helix-sdk-js visibility): once helix-sdk-js is public, delete
# the vendoring below, restore `context: ../..` / `dockerfile: Dockerfile`
# in both examples' docker-compose.yml, and go back to a plain
# `pnpm install --filter @helixid/api`.
#
# Build context: the parent directory containing all four split repos.
FROM node:24-alpine AS builder

WORKDIR /app
RUN corepack enable
# better-sqlite3 and argon2 have native (node-gyp) build steps.
RUN apk add --no-cache python3 make g++ git

COPY helix-server/package.json helix-server/pnpm-lock.yaml helix-server/pnpm-workspace.yaml helix-server/tsconfig.base.json ./
COPY helix-server/helix-api/package.json ./helix-api/
# pnpm-workspace.yaml's globs (examples/*, examples, e2e) need a package.json
# present for every matching directory or pnpm's workspace scan complains --
# we don't need to build any of these for the api image, just satisfy it.
# Only "name" is kept: the real files declare sibling-repo file:/git: deps
# (e2e-consent-demo, e2e-travel-concierge) that pnpm would otherwise try to
# resolve during its whole-workspace scan, even under --filter @helixid/api.
COPY helix-server/e2e/package.json ./e2e/
COPY helix-server/examples/package.json ./examples/
COPY helix-server/examples/e2e-consent-demo/package.json ./examples/e2e-consent-demo/
COPY helix-server/examples/e2e-travel-concierge/package.json ./examples/e2e-travel-concierge/
COPY helix-server/examples/framework-middleware/package.json ./examples/framework-middleware/
RUN for f in e2e/package.json examples/package.json examples/e2e-consent-demo/package.json examples/e2e-travel-concierge/package.json examples/framework-middleware/package.json; do \
      node -e "const j = require('./$f'); require('fs').writeFileSync('$f', JSON.stringify({ name: j.name, version: j.version, private: true }, null, 2));"; \
    done

# Vendored, pre-built @helixid/did-hedera (built via `pnpm --filter
# @helixid/did-hedera build` in the helix-sdk-js repo). Only dist/ +
# package.json are needed -- helix-api resolves it via "main"/"exports".
COPY helix-sdk-js/did-hedera/dist helix-sdk-js/did-hedera/dist
COPY helix-sdk-js/did-hedera/package.json helix-sdk-js/did-hedera/package.json
RUN node -e "const f = 'helix-sdk-js/did-hedera/package.json'; const j = require('./' + f); delete j.scripts; require('fs').writeFileSync(f, JSON.stringify(j, null, 2));" \
 && npm pkg set "dependencies.@helixid/did-hedera=file:../helix-sdk-js/did-hedera" --prefix helix-api \
 && npm pkg delete "devDependencies.@helixid/sdk-js" --prefix helix-api

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile --filter @helixid/api

COPY helix-server/helix-api ./helix-api
# The COPY above brings in the real (unpatched) helix-api/package.json,
# clobbering the in-place edit from above -- re-apply it, since `pnpm deploy`
# below re-resolves @helixid/api's dependency graph from package.json rather
# than reusing the node_modules the earlier `pnpm install` already built.
RUN npm pkg set "dependencies.@helixid/did-hedera=file:../helix-sdk-js/did-hedera" --prefix helix-api \
 && npm pkg delete "devDependencies.@helixid/sdk-js" --prefix helix-api

RUN pnpm --filter @helixid/api build

# Self-contained deployment: all deps resolved from the store, no workspace
# symlinks (so the runner stage doesn't need the rest of the workspace).
RUN pnpm --filter @helixid/api deploy --prod /app/deploy

# `pnpm deploy` re-resolves deps rather than copying node_modules, so it
# drops the .prisma/client output `prisma generate` wrote during the build
# step above. Regenerate it directly into the deploy output using the
# still-present dev CLI (helix-api/node_modules is discarded once only
# /app/deploy is copied into the runner stage).
RUN cd /app/deploy && /app/helix-api/node_modules/.bin/prisma generate


FROM node:24-alpine AS runner

WORKDIR /app
COPY --from=builder /app/deploy ./helix-api

EXPOSE 3000

CMD ["node", "helix-api/dist/server.js"]
