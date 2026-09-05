// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// helix-core's Vc/EnrollmentToken/Challenge tables carry no accountId
// column — core has no concept of accounts (see helix-core's
// prisma/schema.prisma). These three tiny side tables record the same fact
// from the enterprise side instead, keyed by the core row's own natural key
// (vcId / tokenHash / challengeId), since core never returns internal row
// ids across its public service surface. All three tables have an
// identical {key, accountId, createdAt} shape, so one generic class serves
// all three rather than three near-duplicate repository classes.

import type { PrismaClient } from '@prisma/client';
import { sqliteLiteral, type SqliteStore } from '@helixid/core';

type PrismaRaw = PrismaClient & {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

export type AccountLinkTable = 'vc_account_links' | 'enrollment_token_account_links' | 'challenge_account_links';

interface AccountLinkColumns {
  /** Postgres column name — matches Prisma's default camelCase mapping (no @map on the field). */
  pg: 'vcId' | 'tokenHash' | 'challengeId';
  /** SQLite column name — matches this codebase's snake_case raw-SQL convention. */
  sqlite: 'vc_id' | 'token_hash' | 'challenge_id';
}

/**
 * Generic {key -> accountId} lookup, backed by whichever storage adapter
 * this process is configured for. `table`/`column` pick which of the three
 * link tables an instance talks to.
 */
export class AccountLinkRepository {
  constructor(
    private readonly table: AccountLinkTable,
    private readonly column: AccountLinkColumns,
    private readonly prisma?: PrismaClient,
    private readonly sqlite?: SqliteStore,
  ) {}

  private readonly memory = new Map<string, string>();

  async link(key: string, accountId: string): Promise<void> {
    if (this.prisma) {
      await (this.prisma as PrismaRaw).$executeRawUnsafe(
        `INSERT INTO "${this.table}" ("${this.column.pg}", "accountId", "createdAt")
         VALUES ($1, $2, NOW())
         ON CONFLICT ("${this.column.pg}") DO NOTHING`,
        key,
        accountId,
      );
      return;
    }
    if (this.sqlite) {
      this.sqlite.execute(`
        INSERT OR IGNORE INTO ${this.table} (${this.column.sqlite}, account_id, created_at)
        VALUES (${sqliteLiteral(key)}, ${sqliteLiteral(accountId)}, ${sqliteLiteral(new Date())})
      `);
      return;
    }
    if (!this.memory.has(key)) this.memory.set(key, accountId);
  }

  async getAccountId(key: string): Promise<string | null> {
    if (this.prisma) {
      const rows = await (this.prisma as PrismaRaw).$queryRawUnsafe<Array<{ accountId: string }>>(
        `SELECT "accountId" FROM "${this.table}" WHERE "${this.column.pg}" = $1 LIMIT 1`,
        key,
      );
      return rows[0]?.accountId ?? null;
    }
    if (this.sqlite) {
      const rows = this.sqlite.query<{ account_id: string }>(`
        SELECT account_id FROM ${this.table}
        WHERE ${this.column.sqlite} = ${sqliteLiteral(key)}
        LIMIT 1
      `);
      return rows[0]?.account_id ?? null;
    }
    return this.memory.get(key) ?? null;
  }

  async listKeysForAccount(accountId: string): Promise<string[]> {
    if (this.prisma) {
      const rows = await (this.prisma as PrismaRaw).$queryRawUnsafe<Array<{ key: string }>>(
        `SELECT "${this.column.pg}" AS key FROM "${this.table}" WHERE "accountId" = $1`,
        accountId,
      );
      return rows.map((r) => r.key);
    }
    if (this.sqlite) {
      const rows = this.sqlite.query<{ key: string }>(`
        SELECT ${this.column.sqlite} AS key FROM ${this.table}
        WHERE account_id = ${sqliteLiteral(accountId)}
      `);
      return rows.map((r) => r.key);
    }
    return [...this.memory.entries()].filter(([, v]) => v === accountId).map(([k]) => k);
  }
}

export function createVcAccountLinkRepository(
  prisma?: PrismaClient,
  sqlite?: SqliteStore,
): AccountLinkRepository {
  return new AccountLinkRepository('vc_account_links', { pg: 'vcId', sqlite: 'vc_id' }, prisma, sqlite);
}

export function createEnrollmentTokenAccountLinkRepository(
  prisma?: PrismaClient,
  sqlite?: SqliteStore,
): AccountLinkRepository {
  return new AccountLinkRepository(
    'enrollment_token_account_links',
    { pg: 'tokenHash', sqlite: 'token_hash' },
    prisma,
    sqlite,
  );
}

export function createChallengeAccountLinkRepository(
  prisma?: PrismaClient,
  sqlite?: SqliteStore,
): AccountLinkRepository {
  return new AccountLinkRepository(
    'challenge_account_links',
    { pg: 'challengeId', sqlite: 'challenge_id' },
    prisma,
    sqlite,
  );
}
