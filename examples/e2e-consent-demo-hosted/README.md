# e2e-consent-demo-hosted

The same consent-demo scenario as [`../e2e-consent-demo`](../e2e-consent-demo) (two independent Service Providers issuing per-SP consent grants to a Travel Planner agent), rebuilt for the deployment topology a real enterprise customer would actually use:

- **They don't run HelixID's API or Console.** Both are hosted for them (by us). This example never starts, builds, or manages either.
- **They register the agent only through the hosted Console.** There is no seed script here — the agent is enrolled by pasting a one-use Console token into a small script.
- **Their side runs without Docker.** Just three plain Node processes (agent, sp-airline, sp-hotel), talking to the hosted API over a normal HTTP URL.

If you want the fully-bundled, one-command demo instead (Console + API + everything colocated in one docker-compose stack), use `../e2e-consent-demo`.

## What's genuinely local vs. what needs the hosted API

- **Each SP's identity is self-signed and entirely local** — `did:web`, key pair, and initial status list are generated with local crypto (`bootstrap-sps.ts`), with zero calls to HelixID. An SP's legitimacy is its DID, not something HelixID issues or needs to know about ahead of time. This never changes between the colocated and hosted versions.
- **The agent's credential comes from the hosted API**, issued against a token generated in the hosted Console. Every VP an SP receives is verified against that same hosted API.

## Prerequisite: a running hosted API + Console

**Run the hosted API natively (`pnpm run dev`), not via `docker compose up -d helix-api console`.** This is the one real difference from `../e2e-travel-concierge-hosted`, and it's worth understanding why: when the agent books, the SP's own `/api/consent/accept` route calls the hosted API to prepare/finalize the grant VC, and that API call resolves the SP's `did:web:localhost:<port>` document to verify its signing key. If the hosted API is a Docker container, *its* "localhost" is the container's own loopback, not your host machine where the SP process actually listens — the resolution fails with a plain `TypeError: fetch failed`, surfaced to the browser as a generic "An unexpected error occurred." Running the hosted API as a native process puts it in the same "localhost" as everything else, and this disappears entirely. (`../e2e-travel-concierge-hosted` doesn't hit this because its MCP server has no `did:web` identity of its own for the hosted API to resolve.)

```bash
cd ../../helix-server        # or wherever your hosted checkout lives
DATABASE_URL=postgresql://<user>:<pass>@localhost:<port>/<db> \
NODE_ENV=test PORT=3000 HELIX_ADMIN_API_KEY=dev-admin-key-change-in-production \
  pnpm run dev

cd ../../helix-console
pnpm exec vite --port 8080
```

(`NODE_ENV=test` here isn't about running tests — helix-api just refuses to boot in `development` mode against a database whose name looks like a test fixture, as a safety rail. Any real Postgres database works; adjust `DATABASE_URL` to match.)

This exposes the API at `http://localhost:3000` and Console at `http://localhost:8080`. Vite's dev server already proxies `/v1` requests to `http://localhost:3000` (see `helix-console/vite.config.ts`), so Console's browser-side API calls work with no CORS setup needed.

## Run this example

```bash
pnpm install
cp .env.example .env   # LLM_API_KEY is optional -- see below
pnpm run bootstrap-sps   # provisions both SPs' did:web identities, once
pnpm run sp:airline      # terminal 1 — :4101
pnpm run sp:hotel        # terminal 2 — :4102
```

Then register the agent, purely through Console:

1. Open the hosted Console (`http://localhost:8080`) → **Enroll** → agent name "Travel Planner Agent", scopes `book:flights`, `modify:booking`, `book:hotel` → **Mint enrollment token**.
2. `ONBOARD_TOKEN=enroll:xxxx pnpm run onboard-agent` — writes the same `travel-planner.enc` wallet the agent expects, using only the pasted token.
3. `pnpm run agent` (terminal 3 — `http://localhost:4100`) and open it in a browser. Log in with `traveler` / `demo123`.

`HELIX_API_URL` does not need to be set — `helixid-config/index.ts` defaults it to `http://localhost:3000`, same as `../e2e-travel-concierge-hosted`.

No LLM key is required either: leave `LLM_API_KEY` blank (or let a real one fail) and the agent automatically falls back to its deterministic scripted planner — this example is fully testable end to end without any external API quota at all.

## Test plan

1. **Register the agent purely through Console** (steps above). Confirm Console's Agents page shows "Travel Planner Agent" as ACTIVE with the right scopes.
2. **First booking triggers a real consent prompt** — ask the agent to book a Helix Air flight. Confirm a consent popup opens against `sp-airline` (its own `did:web` identity, not the hosted API), sign in (`ada` / `demo123`), approve, and confirm the booking succeeds. Check Console's Audit page shows the verification/issuance chain.
3. **A different SP requires its own, separate consent** — book a Helix Stay hotel. Confirm a *new* consent prompt appears (Helix Stay's grant is independent of Helix Air's).
4. **Repeat booking with the same SP reuses the standing grant** — book another Helix Air flight. Confirm no new consent prompt appears.
5. **Confirm real separation, not accidental coupling** — stop this example's own processes and delete `.data/`. The hosted stack's own data (the agent's credential, both SPs' consent grants, the audit log) is untouched, since none of it lives in this example's process tree.

## What's different from `../e2e-consent-demo`, file by file

- No `docker-compose.yml`, `docker/`, `seed/` — nothing here starts or seeds the hosted side.
- `helixid-config/index.ts` — `helixApiUrl` defaults to `http://localhost:3000` (not `http://helix-api:3000`), `walletsDir` to a local `.data/wallets` folder (not a Docker volume). `airlineUrl`/`hotelUrl`/`consoleUrl` were already `localhost`-based by default in the original, so those are unchanged.
- `bootstrap-sps.ts` (new) — just the SP-identity half of the original `seed/seed.ts`; no agent enrollment, no API calls.
- `onboard-agent.ts` (new) — just the agent-enrollment half, but takes a Console-generated `ONBOARD_TOKEN` instead of self-minting one.
- `agent/`, `sp-airline/`, `sp-hotel/`, `sp-shared/` — unchanged; they only import config, so the new defaults flow through automatically.
