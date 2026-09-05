// Enrolls the Travel Planner Agent using a one-use token pasted from the
// hosted Console's Enroll page -- the whole point of the hosted topology.
//
// Unlike ../e2e-consent-demo/seed/seed.ts, this never mints its own token
// (that would just be a scripted backdoor around Console). Generate one at
// http://localhost:8080 -> Enroll (agent name "Travel Planner Agent", scopes
// book:flights, modify:booking, book:hotel), then:
//
//   ONBOARD_TOKEN=enroll:xxxx pnpm run onboard-agent
//
// Writes the same travel-planner.enc wallet file agent/server.ts already
// expects, so nothing else in this example needs to change.
import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentWallet, HelixClient } from '@helixid/sdk-js';
import { AGENT_PRIVILEGE_SCOPES, DEMO_USER_DID, env } from './helixid-config/index.js';

const AGENT_ID = 'travel-planner';

function log(message: string): void {
  console.log(`[Onboard] ${message}`);
}

async function main(): Promise<void> {
  const token = process.env.ONBOARD_TOKEN;
  if (!token) {
    throw new Error(
      'Missing ONBOARD_TOKEN. Generate one at the hosted Console (Enroll page) and re-run:\n' +
        '  ONBOARD_TOKEN=enroll:xxxx pnpm run onboard-agent',
    );
  }

  await mkdir(env.walletsDir, { recursive: true });
  const walletFile = join(env.walletsDir, `${AGENT_ID}.enc`);
  const wallet = await AgentWallet.create(walletFile, env.walletPassphrase);

  if (wallet.credentials.length > 0) {
    log(`Agent "${AGENT_ID}" already enrolled (${wallet.did}); reusing wallet. Delete .data/ to re-onboard.`);
    return;
  }

  const client = new HelixClient(env.helixApiUrl);
  const vc = (await client.enroll(token, wallet)) as { id: string };

  log(`Issued credential ${vc.id}.`);
  log(`Agent DID          : ${wallet.did}`);
  log(`Authority scopes   : ${AGENT_PRIVILEGE_SCOPES.join(', ')}`);
  log(`End user           : ${DEMO_USER_DID}`);
  log(`Check it in Console: ${env.consoleUrl}`);
}

main().catch((error: unknown) => {
  console.error('[Onboard] failed:', error);
  process.exit(1);
});
