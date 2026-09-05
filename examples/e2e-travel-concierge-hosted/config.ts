// The one place shared constants live. Everything else in this example is a
// single-responsibility file: the MCP server verifies, the agent presents.
//
// This is examples/e2e-travel-concierge, adapted for the *hosted* topology:
// HelixID's API and Console are not run by this example at all -- they're an
// external prerequisite (e.g. `docker compose up -d helix-api console` from
// ../e2e-travel-concierge, or `pnpm run dev` in helix-server itself),
// standing in for a vendor-hosted SaaS instance. This example only contains
// the customer-side services (agent, MCP server) and runs them as plain
// local processes, no Docker at all -- see README.md for the full test plan.
import { join } from 'node:path';

/**
 * The demo maps travel actions onto already-shipped HelixID scopes. HelixID's
 * current privilege-scope allow-list is commerce-oriented, so -- like v1 --
 * "search flights" is `read:catalog` and "book a flight" is `write:orders`.
 */
export const SCOPES = {
  /** Flight search — required by the search_flights tool. */
  FLIGHTS_READ: 'read:catalog',
  /** Flight booking — required by the book_flight tool. */
  FLIGHTS_BOOK: 'write:orders',
} as const;

/** The two protected MCP tools, each gated by one scope. */
export const TOOLS = {
  BOOK: 'book_flight',
  SEARCH: 'search_flights',
} as const;

/** Back-compat alias — the primary protected tool. */
export const PROTECTED_TOOL = TOOLS.BOOK;

/**
 * The service the VP is bound to. The agent stamps this into every presentation
 * (`targetService`) and the MCP server is the audience. It is a plain string
 * identifier — not a URL — and does not need to be pre-registered for the
 * shipped verify + scope path this demo uses.
 */
export const TARGET_SERVICE = 'travel-booking-mcp';

/**
 * A demo user DID the agent claims to act on behalf of. In production this
 * comes from a real user-DID verification flow before the agent acts; here it
 * is a fixed placeholder so the happy path is deterministic.
 */
export const USER_DID = 'did:web:demo-traveler';

/**
 * Unlike e2e-travel-concierge, there is no initial persona and no seed
 * script here: this example starts with zero enrolled agents. The point of
 * the hosted topology is that registration happens *only* through the
 * hosted Console's Enroll page — an operator generates a one-use token there
 * and pastes it into this app's "Onboard new agent" form. See README.md.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const walletsDir = process.env.WALLETS_DIR ?? join(process.cwd(), '.data', 'wallets');

/** Encrypted wallet file for a given persona, on the local wallets dir. */
export function walletPathFor(personaId: string): string {
  return join(walletsDir, `${personaId}.enc`);
}

/** Config resolved from the environment, defaulting to a hosted instance on localhost. */
export const env = {
  /**
   * Hosted HelixID API URL. Hardcoded to localhost:3000 by default -- this
   * example assumes the hosted API is already running there (see README.md)
   * rather than requiring HELIX_API_URL to be set at all. Still overridable
   * if you're pointing at a genuinely remote host.
   */
  helixApiUrl: process.env.HELIX_API_URL ?? 'http://localhost:3000',
  /** Admin key for the convenience revoke/delegate demo routes -- must match whatever the hosted API was started with. */
  adminApiKey: process.env.HELIX_ADMIN_API_KEY ?? 'dev-admin-key-change-in-production',
  /** Directory holding per-persona wallets + the persona manifest (local to this checkout, not a Docker volume). */
  walletsDir,
  /** Manifest listing every enrolled persona (survives restarts). */
  personaManifestPath: join(walletsDir, 'personas.json'),
  walletPassphrase: process.env.WALLET_PASSPHRASE ?? 'demo-passphrase',
  /** MCP server URL the agent connects to -- both run as local processes, not container DNS. */
  mcpServerUrl: process.env.MCP_SERVER_URL ?? 'http://localhost:7100/mcp',
  /** Ports. */
  mcpPort: Number(process.env.MCP_PORT ?? 7100),
  agentPort: Number(process.env.AGENT_PORT ?? 4000),
  /** LLM provider selection. */
  llmProvider: (process.env.LLM_PROVIDER ?? 'anthropic') as 'anthropic' | 'openai' | 'azure' | 'gemini',
  llmApiKeyOrThrow: () => required('LLM_API_KEY'),
  /** Optional model override — currently only read by the Gemini provider. */
  llmModel: process.env.LLM_MODEL || undefined,
  /**
   * Azure OpenAI settings — used only when LLM_PROVIDER=azure. LLM_API_KEY is
   * the Azure resource key; the "model" is your chat deployment name.
   */
  azureOpenAI: {
    endpointOrThrow: () => required('AZURE_OPENAI_ENDPOINT'),
    deploymentOrThrow: () => required('AZURE_OPENAI_DEPLOYMENT'),
    apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21',
  },
};
