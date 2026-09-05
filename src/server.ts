// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0
//
// Enterprise server: composes @helixid/core's routes/services unchanged
// for everything account-agnostic, and layers hosted accounts/auth/quotas
// on top for the rest. See docs/proposal-hosted-instance.md.
import './loadEnv.js';
import crypto from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
import { Redis } from 'ioredis';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  buildDIDDocument,
  derivePublicKey,
  generateKeyPair,
  loadConfigFromEnv,
  resolveDidMethod,
  errorHandler,
  ApiAuditLogger,
  createHederaClient,
  createDidCache,
  createStatusListCache,
  extractEd25519PublicKeyHexFromDIDDocument,
  DidRepository,
  VcRepository,
  AuditLogRepository,
  AgentRepository,
  ServiceRegistryRepository,
  PreparedPayloadRepository,
  DIDService,
  VCService,
  VPService,
  AgentService,
  PreparedPayloadService,
  SqliteStore,
  didRoutes,
  didWebRoutes,
  statusListRoutes,
  vpRoutes,
  sessionRoutes,
  preparedPayloadRoutes,
  type DIDDocument,
  type RedisLike,
} from '@helixid/core';

import { AccountRepository } from './repositories/account.repository.js';
import { IssuerKeyRepository } from './repositories/issuer-key.repository.js';
import { RefreshTokenRepository } from './repositories/refresh-token.repository.js';
import {
  createVcAccountLinkRepository,
  createEnrollmentTokenAccountLinkRepository,
  createChallengeAccountLinkRepository,
} from './repositories/account-links.repository.js';
import { AuthService, AesGcmKeyCustody, ConsoleEmailSender } from './services/auth/index.js';
import vcRoutes from './routes/vc/index.js';
import agentRoutes from './routes/agent/index.js';
import auditLogRoutes from './routes/audit-log/index.js';
import authRoutes from './routes/auth/index.js';
import accountDidRoutes from './routes/account-did/index.js';

// Enterprise-only tables, appended to the same SQLite file core initializes
// (see @helixid/core's SqliteStore — this is its documented extension seam).
const ENTERPRISE_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT,
  google_id TEXT,
  issuer_did TEXT,
  company_name TEXT,
  field_of_operation TEXT,
  email_verified_at TEXT,
  email_verification_token_hash TEXT,
  email_verification_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_google_id ON accounts(google_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_issuer_did ON accounts(issuer_did);

CREATE TABLE IF NOT EXISTS issuer_key_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  did TEXT NOT NULL UNIQUE,
  encrypted_private_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by_token_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_account_id ON refresh_tokens(account_id);

CREATE TABLE IF NOT EXISTS vc_account_links (
  vc_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vc_account_links_account_id ON vc_account_links(account_id);

CREATE TABLE IF NOT EXISTS enrollment_token_account_links (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enrollment_token_account_links_account_id ON enrollment_token_account_links(account_id);

CREATE TABLE IF NOT EXISTS challenge_account_links (
  challenge_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`.trim();

const config = loadConfigFromEnv();
const storageAdapter =
  (config as unknown as { HELIX_STORAGE_ADAPTER?: 'sqlite' | 'postgres' }).HELIX_STORAGE_ADAPTER ??
  'postgres';
const cacheAdapter =
  (config as unknown as { HELIX_CACHE_ADAPTER?: 'memory' | 'redis' }).HELIX_CACHE_ADAPTER ??
  'memory';
const usingPostgres = storageAdapter === 'postgres';
const usingSqlite = storageAdapter === 'sqlite';
const apiPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuredSqlitePath =
  (config as unknown as { HELIX_SQLITE_PATH?: string }).HELIX_SQLITE_PATH ?? 'data/helixid.sqlite';
const sqlitePath = isAbsolute(configuredSqlitePath)
  ? configuredSqlitePath
  : resolve(apiPackageDir, configuredSqlitePath);
const databaseName = getDatabaseName(config.DATABASE_URL);

if (usingPostgres && config.NODE_ENV !== 'test' && /test/i.test(databaseName)) {
  throw new Error(
    `Refusing to start ${config.NODE_ENV} API against test database '${databaseName}'. ` +
      'Set DATABASE_URL to the working database or run with NODE_ENV=test intentionally.',
  );
}

const pool = usingPostgres ? new pg.Pool({ connectionString: config.DATABASE_URL }) : null;
const adapter = pool ? new PrismaPg(pool) : null;
const prisma = adapter ? new PrismaClient({ adapter }) : undefined;
const sqlite = usingSqlite ? new SqliteStore(sqlitePath, ENTERPRISE_SQLITE_DDL) : undefined;

const redis: RedisLike | null =
  cacheAdapter === 'redis' && config.CACHE_L2_ENABLED && config.REDIS_URL
    ? new Redis(config.REDIS_URL)
    : null;

const auditLogger = new ApiAuditLogger(prisma, config, sqlite);
const didRepository = new DidRepository(prisma, sqlite);
const vcRepository = new VcRepository(prisma, sqlite);
const auditLogRepository = new AuditLogRepository(prisma, sqlite);
const agentRepository = new AgentRepository(prisma, sqlite);
const serviceRegistry = new ServiceRegistryRepository(agentRepository);
const preparedPayloadRepository = new PreparedPayloadRepository(prisma, sqlite);
const accountRepository = new AccountRepository(prisma, sqlite);
const issuerKeyRepository = new IssuerKeyRepository(prisma, sqlite);
const refreshTokenRepository = new RefreshTokenRepository(prisma, sqlite);
const vcAccountLinkRepository = createVcAccountLinkRepository(prisma, sqlite);
const enrollmentTokenAccountLinkRepository = createEnrollmentTokenAccountLinkRepository(prisma, sqlite);
const challengeAccountLinkRepository = createChallengeAccountLinkRepository(prisma, sqlite);
await serviceRegistry.seedBuiltIns();

await ensureIssuerDidCached();

const didMethod = resolveDidMethod(process.env);
const hederaClient = await createHederaClient(config);
const didCache = createDidCache<DIDDocument>(config, redis);
const statusListCache = createStatusListCache<string>(config, redis);
const jwtSessionKeyPair = generateKeyPair();

const didService = new DIDService(
  didRepository,
  hederaClient,
  auditLogger,
  didCache,
  config.DID_CACHE_L1_TTL_SECONDS,
  didMethod,
  config.DID_DOMAIN,
);
const vcService = new VCService(
  vcRepository,
  didService,
  auditLogger,
  config.HELIX_SIGNING_KEY,
  config.HELIX_ISSUER_DID,
  config.API_BASE_URL,
  statusListCache,
  config.STATUS_LIST_CACHE_L1_TTL_SECONDS,
);
const vpService = new VPService(vcService, auditLogger, config.API_BASE_URL, {
  signingKey: jwtSessionKeyPair.privateKey,
  issuerDid: config.HELIX_ISSUER_DID,
  ttlSeconds: config.JWT_SESSION_TTL_SECONDS,
});
const agentService = new AgentService(agentRepository, didService, vcService, auditLogger);
const preparedPayloadService = new PreparedPayloadService(preparedPayloadRepository, didService);

// Hosted accounts & auth (Item #1, see docs/proposal-hosted-instance.md).
// Both secrets fall back to a random per-process value when unset, so
// self-hosted / dev environments boot without configuring them — but that
// means encrypted IssuerKeyRecord rows and issued sessions won't survive a
// restart in that mode. Set HOSTED_KEY_ENCRYPTION_KEY / HOSTED_ACCESS_TOKEN_SECRET
// explicitly for any deployment that needs persistence across restarts.
const hostedKeyEncryptionKey = config.HOSTED_KEY_ENCRYPTION_KEY ?? crypto.randomBytes(32).toString('hex');
const hostedAccessTokenSecret =
  config.HOSTED_ACCESS_TOKEN_SECRET ?? crypto.randomBytes(32).toString('hex');
const hostedDidDomain = config.HOSTED_DID_DOMAIN;
const hostedAccessTokenTtlSeconds = config.HOSTED_ACCESS_TOKEN_TTL_SECONDS;
const hostedRefreshTokenTtlDays = config.HOSTED_REFRESH_TOKEN_TTL_DAYS;
const keyCustody = new AesGcmKeyCustody(hostedKeyEncryptionKey);
const emailSender = new ConsoleEmailSender();
const hostedConsoleBaseUrl = config.HOSTED_CONSOLE_BASE_URL;
const hostedEmailVerificationTtlHours = config.HOSTED_EMAIL_VERIFICATION_TTL_HOURS;
const authService = new AuthService(
  accountRepository,
  didRepository,
  issuerKeyRepository,
  refreshTokenRepository,
  keyCustody,
  auditLogger,
  hostedAccessTokenSecret,
  hostedDidDomain,
  hostedAccessTokenTtlSeconds,
  hostedRefreshTokenTtlDays,
  emailSender,
  hostedConsoleBaseUrl,
  hostedEmailVerificationTtlHours,
);

const app = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: ['req.headers.authorization', 'req.body.privateKey', 'req.body.privateKeyHex'],
  },
  genReqId: () => `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
});

// Per-IP rate limiting (proposal-hosted-rate-limiting.md, §1 — decided).
// Only applies in hosted mode: self-hosted single-operator deployments
// shouldn't have hosted-tier limits forced on them. Global ceiling here;
// tighter per-route overrides are set via `config.rateLimit` on the
// individual auth routes (see routes/auth/index.ts).
const isHostedMode = config.HOSTED_MODE;
const rateLimitGlobalMax = config.HOSTED_RATE_LIMIT_GLOBAL_MAX;

if (isHostedMode) {
  await app.register(rateLimit, {
    global: true,
    max: rateLimitGlobalMax,
    timeWindow: '1 minute',
  });
}

app.addSchema({
  $id: 'Error',
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
});
app.addSchema({ $id: 'BadRequest', type: 'object', $ref: 'Error#' });
app.addSchema({ $id: 'NotFound', type: 'object', $ref: 'Error#' });
app.addSchema({ $id: 'Conflict', type: 'object', $ref: 'Error#' });

app.setErrorHandler(errorHandler);

app.get('/health', async () => ({
  status: 'ok',
  version: '0.1.0',
  environment: config.NODE_ENV,
  storageAdapter,
  database: usingPostgres ? databaseName : usingSqlite ? sqlitePath : 'disabled',
  cacheAdapter,
  didMethod,
  issuerDid: config.HELIX_ISSUER_DID,
}));

function getDatabaseName(databaseUrl: string | undefined): string {
  if (!databaseUrl) return 'none';
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    return 'unknown';
  }
}

async function ensureIssuerDidCached(): Promise<void> {
  const expectedPublicKey = derivePublicKey(config.HELIX_SIGNING_KEY).toLowerCase();
  const existing = await didRepository.findDidById(config.HELIX_ISSUER_DID);
  if (existing) {
    const existingPublicKey = extractEd25519PublicKeyHexFromDIDDocument(existing.didDocument);
    if (existingPublicKey !== expectedPublicKey) {
      throw new Error(
        'Configured issuer DID public key does not match HELIX_SIGNING_KEY. ' +
          'Run setup with matching issuer material or fix HELIX_ISSUER_DID before issuing VCs.',
      );
    }
    return;
  }

  const didDocument = buildDIDDocument(config.HELIX_ISSUER_DID, expectedPublicKey);
  await didRepository.createDid({
    id: config.HELIX_ISSUER_DID,
    subjectType: 'user',
    controller: config.HELIX_ISSUER_DID,
    publicKey: expectedPublicKey,
    publicKeyMultibase: didDocument.verificationMethod[0]!.publicKeyMultibase,
    hederaTransactionId: `configured-issuer:${config.HELIX_ISSUER_DID}`,
    didDocument,
  });
}

const accountOrAdminGuardDeps = {
  authService,
  accountRepository,
  auditLogRepository,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
};

// Unchanged from core — no account concept touches these at all.
await app.register(didRoutes, { didService });
await app.register(didWebRoutes, { issuerDid: config.HELIX_ISSUER_DID, didDomain: config.DID_DOMAIN, didRepository });
await app.register(preparedPayloadRoutes, {
  prefix: '/v1/vcs',
  preparedPayloadService,
});
await app.register(statusListRoutes, {
  prefix: '/v1/status-list',
  vcService,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
});
await app.register(vpRoutes, { prefix: '/v1/vp', vpService });
await app.register(sessionRoutes, {
  prefix: '/v1/sessions',
  publicKeyHex: jwtSessionKeyPair.publicKey,
});

// Enterprise's own wrappers around core's VC/agent/audit-log services —
// core-agnostic account scoping layered on top (see each route file's
// header comment for how ownership is tracked without a column on a
// core-owned table).
await app.register(vcRoutes, {
  prefix: '/v1/vcs',
  vcService,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
  accountOrAdminGuardDeps,
  vcIssuanceDailyQuota: config.HOSTED_QUOTA_VC_ISSUANCE_PER_DAY,
  vcAccountLinkRepository,
  auditLogger,
});
await app.register(auditLogRoutes, {
  prefix: '/v1/audit-log',
  auditLogRepository,
  auditLogger,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
  accountOrAdminGuardDeps,
  vcAccountLinkRepository,
  enrollmentTokenAccountLinkRepository,
});
await app.register(agentRoutes, {
  prefix: '/v1',
  agentService,
  accountOrAdminGuardDeps,
  enrollmentTokenDailyQuota: config.HOSTED_QUOTA_ENROLLMENT_TOKEN_PER_DAY,
  enrollmentTokenAccountLinkRepository,
  challengeAccountLinkRepository,
  vcAccountLinkRepository,
  auditLogger,
});
await app.register(authRoutes, {
  prefix: '/v1/auth',
  authService,
  googleClientId: config.GOOGLE_CLIENT_ID,
  googleClientSecret: config.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: config.GOOGLE_OAUTH_REDIRECT_URI,
});
await app.register(accountDidRoutes, { didDomain: hostedDidDomain, didRepository });

const shutdown = async (): Promise<void> => {
  app.log.info('Helix ID API shutting down...');
  await app.close();
  (redis as Redis | null)?.disconnect();
  await prisma?.$disconnect();
  await pool?.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
