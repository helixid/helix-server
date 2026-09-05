// Provisions both SPs' did:web identities + initial status lists.
//
// Unlike ../e2e-consent-demo/seed/seed.ts, this does *not* also enroll the
// agent -- that's onboard-agent.ts now, using a token pasted from the hosted
// Console instead of a self-minted one. This script is pure local crypto
// (generateKeyPair, buildStatusListCredential) with zero calls to the hosted
// API at all: an SP's identity is its own did:web, not something HelixID
// issues or needs to know about ahead of time.
//
// Run once. Re-running is a no-op if both SPs are already provisioned (see
// provisionSpIdentity's `created` flag) -- delete .data/ to start over.
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { SPS, env } from './helixid-config/index.js';
import { provisionSpIdentity, statePath } from './sp-shared/identity.js';

function log(message: string): void {
  console.log(`[Bootstrap] ${message}`);
}

async function main(): Promise<void> {
  for (const sp of SPS) {
    const { identity, statusList, created } = await provisionSpIdentity({
      dir: env.walletsDir,
      spId: sp.id,
      host: env.host,
      port: sp.port,
    });

    if (created) {
      await writeFile(
        statePath(env.walletsDir, sp.id),
        JSON.stringify({ statusList, grants: [] }, null, 2),
        'utf8',
      );
      log(`Provisioned ${sp.displayName}: ${identity.did}`);
      log(`  status list -> ${identity.statusListUrl}`);
    } else {
      log(`${sp.displayName} already provisioned (${identity.did}); reusing.`);
    }
  }
  log('Done. Start both SPs (`pnpm run sp:airline`, `pnpm run sp:hotel`), then run onboard-agent.ts.');
}

main().catch((error: unknown) => {
  console.error('[Bootstrap] failed:', error);
  process.exit(1);
});
