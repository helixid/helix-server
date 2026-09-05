# e2e-travel-concierge-hosted

The same travel-concierge scenario as [`../e2e-travel-concierge`](../e2e-travel-concierge), rebuilt for the deployment topology a real enterprise customer would actually use:

- **They don't run HelixID's API or Console.** Both are hosted for them (by us). This example never starts, builds, or manages either.
- **They register agents only through the hosted Console.** There is no seed script here — this example starts with zero agents. The first one is onboarded by pasting a one-use token generated in Console, exactly like every agent after it.
- **Their side runs without Docker.** Just two plain Node processes (agent, MCP server), talking to the hosted API over a normal HTTP URL.

If you want the fully-bundled, one-command demo instead (Console + API + everything colocated in one docker-compose stack), use `../e2e-travel-concierge`.

## Prerequisite: a running hosted API + Console

Anything that serves a working HelixID API + Console works. The simplest option, reusing the existing demo's images:

```bash
cd ../e2e-travel-concierge
docker compose up -d helix-api console
```

This exposes the API at `http://localhost:3000` and Console at `http://localhost:8080` — **do not** also start `helixid-setup`, `agent`, `mcp-server`, or `web` from that stack; this example replaces those with its own dockerless versions. Do not run its seed script either — this example's whole point is that registration happens through Console, not a seed script.

(Alternatively, run `helix-server` itself directly with `pnpm run dev` if you'd rather not use Docker for the hosted side either — any HelixID instance reachable at `localhost:3000` works.)

## Run this example

```bash
pnpm install
cp .env.example .env   # fill in LLM_API_KEY
pnpm run mcp     # terminal 1 — MCP server on :7100
pnpm run agent   # terminal 2 — agent + web UI on :4000, no nginx needed
```

Open `http://localhost:4000`. You should see **zero personas** — nothing is pre-seeded.

`HELIX_API_URL` does not need to be set. `config.ts` defaults it to `http://localhost:3000` — the same thing every other setting in this example does: point at a hosted instance on localhost by default, override only if you're pointing somewhere else.

## Test plan

1. **Register the first agent purely through Console** — open the hosted Console (`http://localhost:8080`) → **Enroll**, generate a token for e.g. "Concierge Agent" with `read:catalog` + `write:orders`. Back in this app, click **Onboard new agent**, paste the token. Confirm a persona appears with a real DID and VC — check Console's **Agents** page shows it too.
2. **Customer-side actions authorize against the hosted API** — select the new agent, ask it to book a flight. Confirm it succeeds, and that the request/verify/issue events show up in the hosted Console's **Audit** page.
3. **Revoke from Console takes effect immediately** — revoke the agent's credential (via Console directly, or this app's own "Revoke selected agent" button, which calls the hosted API the same way) and retry the booking. Confirm it's refused with `VC_REVOKED` — proving authority stays with the hosted side even though this app's process tree is completely separate from it.
4. **Delegation works the same way** — use the "Create demo agents" / "Delegate read access" buttons (Use case 4) to confirm delegated, narrower-scoped agents behave identically to the colocated demo.
5. **Confirm real separation, not accidental coupling** — stop this example's own processes (`Ctrl-C` both terminals) and delete `.data/`. The hosted stack's own data (agents, credentials, audit log) is untouched, since this app never shared a filesystem, network namespace, or process tree with it — only HTTP calls to a stable URL.

## What's different from `../e2e-travel-concierge`, file by file

- No `docker-compose.yml`, `docker/`, `helixid-setup/` — nothing here starts or seeds the hosted side.
- `config.ts` — `helixApiUrl` defaults to `http://localhost:3000` (not `http://helix-api:3000`), `mcpServerUrl` to `http://localhost:7100/mcp` (not container DNS), `walletsDir` to a local `.data/wallets` folder (not a Docker volume). No `INITIAL_PERSONA`.
- `agent/server.ts` — serves `web/index.html` directly via `express.static`, since there's no nginx container to proxy it.
- `web/` — no `Dockerfile` or `nginx.conf`; `index.html` is unchanged (its `fetch()` calls are already same-origin relative paths).
