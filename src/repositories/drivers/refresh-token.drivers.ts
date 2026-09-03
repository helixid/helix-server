// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Storage-driver implementations for RefreshTokenRepository — see
// storage/driver-registry.ts for the pattern and
// repositories/drivers/did.drivers.ts for the reference implementation.

import type { PrismaClient } from '@prisma/client';
import type { SqliteStore } from '../../storage/sqlite.js';
import { sqliteLiteral } from '../../storage/sqlite.js';
import {
  UnsupportedStorageDriverError,
  type StorageDriverDeps,
  type StorageDriverKind,
} from '../../storage/driver-registry.js';
import type { RefreshTokenRecord } from '../refresh-token.repository.js';

type PrismaRaw = PrismaClient & {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

type PrismaWithRefreshToken = PrismaClient & {
  refreshToken: {
    create(args: { data: Record<string, unknown> }): Promise<RefreshTokenRecord>;
    findUnique(args: { where: Record<string, unknown> }): Promise<RefreshTokenRecord | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<RefreshTokenRecord>;
    updateMany(args: {
      where: { accountId: string; revokedAt: null };
      data: { revokedAt: Date };
    }): Promise<{ count: number }>;
  };
};

export interface RefreshTokenStorageDriver {
  create(data: { accountId: string; tokenHash: string; expiresAt: Date }): Promise<RefreshTokenRecord>;
  findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  revoke(id: string, replacedByTokenId?: string): Promise<void>;
  revokeAllForAccount(accountId: string): Promise<void>;
}

function makeId(): string {
  return `rtk:${Math.random().toString(16).slice(2, 14)}`;
}

function hasRealRaw(prisma: PrismaClient): boolean {
  return (
    typeof (prisma as Partial<PrismaRaw>).$queryRawUnsafe === 'function' &&
    typeof (prisma as { $connect?: unknown }).$connect === 'function'
  );
}

export class PrismaRefreshTokenStorageDriver implements RefreshTokenStorageDriver {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    accountId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshTokenRecord> {
    const id = makeId();
    const createdAt = new Date();

    if (hasRealRaw(this.prisma)) {
      const rows = await (this.prisma as PrismaRaw).$queryRawUnsafe<RefreshTokenRecord[]>(
        `INSERT INTO "refresh_tokens" (
          "id", "accountId", "tokenHash", "expiresAt", "revokedAt", "replacedByTokenId", "createdAt"
        ) VALUES ($1, $2, $3, $4, NULL, NULL, $5)
        RETURNING *`,
        id,
        data.accountId,
        data.tokenHash,
        data.expiresAt,
        createdAt,
      );
      const row = rows[0];
      if (!row) throw new Error('RefreshToken insert returned no rows');
      return row;
    }

    return (await (this.prisma as PrismaWithRefreshToken).refreshToken.create({
      data: { id, accountId: data.accountId, tokenHash: data.tokenHash, expiresAt: data.expiresAt },
    })) as RefreshTokenRecord;
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    if (hasRealRaw(this.prisma)) {
      const rows = await (this.prisma as PrismaRaw).$queryRawUnsafe<RefreshTokenRecord[]>(
        `SELECT * FROM "refresh_tokens" WHERE "tokenHash" = $1 LIMIT 1`,
        tokenHash,
      );
      return rows[0] ?? null;
    }
    return (this.prisma as PrismaWithRefreshToken).refreshToken.findUnique({
      where: { tokenHash },
    });
  }

  async revoke(id: string, replacedByTokenId?: string): Promise<void> {
    const now = new Date();
    if (hasRealRaw(this.prisma)) {
      await (this.prisma as PrismaRaw).$queryRawUnsafe(
        `UPDATE "refresh_tokens" SET "revokedAt" = $1, "replacedByTokenId" = $2 WHERE "id" = $3`,
        now,
        replacedByTokenId ?? null,
        id,
      );
      return;
    }
    await (this.prisma as PrismaWithRefreshToken).refreshToken.update({
      where: { id },
      data: { revokedAt: now, replacedByTokenId: replacedByTokenId ?? null },
    });
  }

  async revokeAllForAccount(accountId: string): Promise<void> {
    const now = new Date();
    if (hasRealRaw(this.prisma)) {
      await (this.prisma as PrismaRaw).$queryRawUnsafe(
        `UPDATE "refresh_tokens" SET "revokedAt" = $1 WHERE "accountId" = $2 AND "revokedAt" IS NULL`,
        now,
        accountId,
      );
      return;
    }
    await (this.prisma as PrismaWithRefreshToken).refreshToken.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}

type SqliteRefreshTokenRow = {
  id: string;
  account_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by_token_id: string | null;
  created_at: string;
};

function fromSqliteRow(row: SqliteRefreshTokenRow | undefined): RefreshTokenRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    tokenHash: row.token_hash,
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    replacedByTokenId: row.replaced_by_token_id,
    createdAt: new Date(row.created_at),
  };
}

export class SqliteRefreshTokenStorageDriver implements RefreshTokenStorageDriver {
  constructor(private readonly sqlite: SqliteStore) {}

  async create(data: {
    accountId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshTokenRecord> {
    const id = makeId();
    const createdAt = new Date();
    this.sqlite.execute(`
      INSERT INTO refresh_tokens (id, account_id, token_hash, expires_at, revoked_at, replaced_by_token_id, created_at)
      VALUES (
        ${sqliteLiteral(id)},
        ${sqliteLiteral(data.accountId)},
        ${sqliteLiteral(data.tokenHash)},
        ${sqliteLiteral(data.expiresAt)},
        NULL,
        NULL,
        ${sqliteLiteral(createdAt)}
      )
    `);
    return {
      id,
      accountId: data.accountId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      revokedAt: null,
      replacedByTokenId: null,
      createdAt,
    };
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const rows = this.sqlite.query<SqliteRefreshTokenRow>(
      `SELECT * FROM refresh_tokens WHERE token_hash = ${sqliteLiteral(tokenHash)} LIMIT 1`,
    );
    return fromSqliteRow(rows[0]);
  }

  async revoke(id: string, replacedByTokenId?: string): Promise<void> {
    const now = new Date();
    this.sqlite.execute(`
      UPDATE refresh_tokens
      SET revoked_at = ${sqliteLiteral(now)}, replaced_by_token_id = ${sqliteLiteral(replacedByTokenId ?? null)}
      WHERE id = ${sqliteLiteral(id)}
    `);
  }

  async revokeAllForAccount(accountId: string): Promise<void> {
    const now = new Date();
    this.sqlite.execute(`
      UPDATE refresh_tokens SET revoked_at = ${sqliteLiteral(now)}
      WHERE account_id = ${sqliteLiteral(accountId)} AND revoked_at IS NULL
    `);
  }
}

export class InMemoryRefreshTokenStorageDriver implements RefreshTokenStorageDriver {
  private readonly rowsByHash = new Map<string, RefreshTokenRecord>();

  async create(data: {
    accountId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshTokenRecord> {
    const record: RefreshTokenRecord = {
      id: makeId(),
      accountId: data.accountId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      revokedAt: null,
      replacedByTokenId: null,
      createdAt: new Date(),
    };
    this.rowsByHash.set(data.tokenHash, record);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return this.rowsByHash.get(tokenHash) ?? null;
  }

  async revoke(id: string, replacedByTokenId?: string): Promise<void> {
    const now = new Date();
    for (const record of this.rowsByHash.values()) {
      if (record.id === id) {
        record.revokedAt = now;
        record.replacedByTokenId = replacedByTokenId ?? null;
      }
    }
  }

  async revokeAllForAccount(accountId: string): Promise<void> {
    const now = new Date();
    for (const record of this.rowsByHash.values()) {
      if (record.accountId === accountId && !record.revokedAt) {
        record.revokedAt = now;
      }
    }
  }
}

export function createRefreshTokenStorageDriver(
  kind: StorageDriverKind,
  deps: StorageDriverDeps,
): RefreshTokenStorageDriver {
  switch (kind) {
    case 'postgres':
      if (!deps.prisma)
        throw new Error("createRefreshTokenStorageDriver('postgres') requires deps.prisma");
      return new PrismaRefreshTokenStorageDriver(deps.prisma as PrismaClient);
    case 'sqlite':
      if (!deps.sqlite)
        throw new Error("createRefreshTokenStorageDriver('sqlite') requires deps.sqlite");
      return new SqliteRefreshTokenStorageDriver(deps.sqlite as SqliteStore);
    case 'memory':
      return new InMemoryRefreshTokenStorageDriver();
    default: {
      const _exhaustive: never = kind;
      throw new UnsupportedStorageDriverError('RefreshTokenRepository', _exhaustive);
    }
  }
}
