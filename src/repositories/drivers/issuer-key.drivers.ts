// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Storage-driver implementations for IssuerKeyRepository — see
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
import type { IssuerKeyRecordRow } from '../issuer-key.repository.js';

type PrismaRaw = PrismaClient & {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

type PrismaWithIssuerKeyRecord = PrismaClient & {
  issuerKeyRecord: {
    create(args: { data: Record<string, unknown> }): Promise<IssuerKeyRecordRow>;
    findUnique(args: { where: Record<string, unknown> }): Promise<IssuerKeyRecordRow | null>;
  };
};

export interface IssuerKeyStorageDriver {
  create(data: Omit<IssuerKeyRecordRow, 'id' | 'createdAt'>): Promise<IssuerKeyRecordRow>;
  findByAccountId(accountId: string): Promise<IssuerKeyRecordRow | null>;
}

function makeId(): string {
  return `ikr:${Math.random().toString(16).slice(2, 14)}`;
}

function hasRealRaw(prisma: PrismaClient): boolean {
  return (
    typeof (prisma as Partial<PrismaRaw>).$queryRawUnsafe === 'function' &&
    typeof (prisma as { $connect?: unknown }).$connect === 'function'
  );
}

export class PrismaIssuerKeyStorageDriver implements IssuerKeyStorageDriver {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: Omit<IssuerKeyRecordRow, 'id' | 'createdAt'>): Promise<IssuerKeyRecordRow> {
    const id = makeId();
    const createdAt = new Date();

    if (hasRealRaw(this.prisma)) {
      const rows = await (this.prisma as PrismaRaw).$queryRawUnsafe<IssuerKeyRecordRow[]>(
        `INSERT INTO "issuer_key_records" (
          "id", "accountId", "did", "encryptedPrivateKey", "iv", "authTag", "algorithm", "createdAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        id,
        data.accountId,
        data.did,
        data.encryptedPrivateKey,
        data.iv,
        data.authTag,
        data.algorithm,
        createdAt,
      );
      const row = rows[0];
      if (!row) throw new Error('IssuerKeyRecord insert returned no rows');
      return row;
    }

    return (await (this.prisma as PrismaWithIssuerKeyRecord).issuerKeyRecord.create({
      data: { id, ...data },
    })) as IssuerKeyRecordRow;
  }

  async findByAccountId(accountId: string): Promise<IssuerKeyRecordRow | null> {
    if (hasRealRaw(this.prisma)) {
      const rows = await (this.prisma as PrismaRaw).$queryRawUnsafe<IssuerKeyRecordRow[]>(
        `SELECT * FROM "issuer_key_records" WHERE "accountId" = $1 LIMIT 1`,
        accountId,
      );
      return rows[0] ?? null;
    }
    return (this.prisma as PrismaWithIssuerKeyRecord).issuerKeyRecord.findUnique({
      where: { accountId },
    });
  }
}

type SqliteIssuerKeyRow = {
  id: string;
  account_id: string;
  did: string;
  encrypted_private_key: string;
  iv: string;
  auth_tag: string;
  algorithm: string;
  created_at: string;
};

function fromSqliteRow(row: SqliteIssuerKeyRow | undefined): IssuerKeyRecordRow | null {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    did: row.did,
    encryptedPrivateKey: row.encrypted_private_key,
    iv: row.iv,
    authTag: row.auth_tag,
    algorithm: row.algorithm,
    createdAt: new Date(row.created_at),
  };
}

export class SqliteIssuerKeyStorageDriver implements IssuerKeyStorageDriver {
  constructor(private readonly sqlite: SqliteStore) {}

  async create(data: Omit<IssuerKeyRecordRow, 'id' | 'createdAt'>): Promise<IssuerKeyRecordRow> {
    const id = makeId();
    const createdAt = new Date();
    this.sqlite.execute(`
      INSERT INTO issuer_key_records (
        id, account_id, did, encrypted_private_key, iv, auth_tag, algorithm, created_at
      ) VALUES (
        ${sqliteLiteral(id)},
        ${sqliteLiteral(data.accountId)},
        ${sqliteLiteral(data.did)},
        ${sqliteLiteral(data.encryptedPrivateKey)},
        ${sqliteLiteral(data.iv)},
        ${sqliteLiteral(data.authTag)},
        ${sqliteLiteral(data.algorithm)},
        ${sqliteLiteral(createdAt)}
      )
    `);
    return { id, ...data, createdAt };
  }

  async findByAccountId(accountId: string): Promise<IssuerKeyRecordRow | null> {
    const rows = this.sqlite.query<SqliteIssuerKeyRow>(
      `SELECT * FROM issuer_key_records WHERE account_id = ${sqliteLiteral(accountId)} LIMIT 1`,
    );
    return fromSqliteRow(rows[0]);
  }
}

export class InMemoryIssuerKeyStorageDriver implements IssuerKeyStorageDriver {
  private readonly rowsByAccount = new Map<string, IssuerKeyRecordRow>();

  async create(data: Omit<IssuerKeyRecordRow, 'id' | 'createdAt'>): Promise<IssuerKeyRecordRow> {
    const record: IssuerKeyRecordRow = { id: makeId(), ...data, createdAt: new Date() };
    this.rowsByAccount.set(data.accountId, record);
    return record;
  }

  async findByAccountId(accountId: string): Promise<IssuerKeyRecordRow | null> {
    return this.rowsByAccount.get(accountId) ?? null;
  }
}

export function createIssuerKeyStorageDriver(
  kind: StorageDriverKind,
  deps: StorageDriverDeps,
): IssuerKeyStorageDriver {
  switch (kind) {
    case 'postgres':
      if (!deps.prisma) throw new Error("createIssuerKeyStorageDriver('postgres') requires deps.prisma");
      return new PrismaIssuerKeyStorageDriver(deps.prisma as PrismaClient);
    case 'sqlite':
      if (!deps.sqlite) throw new Error("createIssuerKeyStorageDriver('sqlite') requires deps.sqlite");
      return new SqliteIssuerKeyStorageDriver(deps.sqlite as SqliteStore);
    case 'memory':
      return new InMemoryIssuerKeyStorageDriver();
    default: {
      const _exhaustive: never = kind;
      throw new UnsupportedStorageDriverError('IssuerKeyRepository', _exhaustive);
    }
  }
}
