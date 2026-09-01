// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Storage-driver implementations for AccountRepository — see
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
import type { AccountRecord } from '../account.repository.js';

type PrismaRaw = PrismaClient & {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

// The Account Prisma model type isn't available until `prisma generate`
// re-runs against the updated schema. Mirrors PreparedPayloadRepository's
// pattern: a minimal structural type so this file typechecks today and
// works unchanged once the client regenerates.
type PrismaWithAccount = PrismaClient & {
  account: {
    create(args: { data: Record<string, unknown> }): Promise<AccountRecord>;
    findUnique(args: { where: Record<string, unknown> }): Promise<AccountRecord | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<AccountRecord>;
  };
};

export interface AccountStorageDriver {
  create(data: { email: string; passwordHash: string | null; googleId: string | null }): Promise<AccountRecord>;
  findById(id: string): Promise<AccountRecord | null>;
  findByEmail(email: string): Promise<AccountRecord | null>;
  findByGoogleId(googleId: string): Promise<AccountRecord | null>;
  findByEmailVerificationTokenHash(tokenHash: string): Promise<AccountRecord | null>;
  update(id: string, patch: Partial<AccountRecord>): Promise<AccountRecord>;
}

function makeId(): string {
  return `acct:${Math.random().toString(16).slice(2, 14)}`;
}

function hasRealRaw(prisma: PrismaClient): boolean {
  return (
    typeof (prisma as Partial<PrismaRaw>).$queryRawUnsafe === 'function' &&
    typeof (prisma as { $connect?: unknown }).$connect === 'function'
  );
}

export class PrismaAccountStorageDriver implements AccountStorageDriver {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    email: string;
    passwordHash: string | null;
    googleId: string | null;
  }): Promise<AccountRecord> {
    const id = makeId();
    const now = new Date();

    if (hasRealRaw(this.prisma)) {
      const rows = await (this.prisma as PrismaRaw).$queryRawUnsafe<AccountRecord[]>(
        `INSERT INTO "accounts" (
          "id", "email", "passwordHash", "googleId", "issuerDid", "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, NULL, $5, $5)
        RETURNING *`,
        id,
        data.email,
        data.passwordHash,
        data.googleId,
        now,
      );
      const row = rows[0];
      if (!row) throw new Error('Account insert returned no rows');
      return row;
    }

    return (await (this.prisma as PrismaWithAccount).account.create({
      data: {
        id,
        email: data.email,
        passwordHash: data.passwordHash,
        googleId: data.googleId,
      },
    })) as AccountRecord;
  }

  async findById(id: string): Promise<AccountRecord | null> {
    if (hasRealRaw(this.prisma)) {
      const rows = await (this.prisma as PrismaRaw).$queryRawUnsafe<AccountRecord[]>(
        `SELECT * FROM "accounts" WHERE "id" = $1 LIMIT 1`,
        id,
      );
      return rows[0] ?? null;
    }
    return (this.prisma as PrismaWithAccount).account.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {
    if (hasRealRaw(this.prisma)) {
      const rows = await (this.prisma as PrismaRaw).$queryRawUnsafe<AccountRecord[]>(
        `SELECT * FROM "accounts" WHERE "email" = $1 LIMIT 1`,
        email,
      );
      return rows[0] ?? null;
    }
    return (this.prisma as PrismaWithAccount).account.findUnique({ where: { email } });
  }

  async findByGoogleId(googleId: string): Promise<AccountRecord | null> {
    if (hasRealRaw(this.prisma)) {
      const rows = await (this.prisma as PrismaRaw).$queryRawUnsafe<AccountRecord[]>(
        `SELECT * FROM "accounts" WHERE "googleId" = $1 LIMIT 1`,
        googleId,
      );
      return rows[0] ?? null;
    }
    return (this.prisma as PrismaWithAccount).account.findUnique({ where: { googleId } });
  }

  async findByEmailVerificationTokenHash(tokenHash: string): Promise<AccountRecord | null> {
    if (hasRealRaw(this.prisma)) {
      const rows = await (this.prisma as PrismaRaw).$queryRawUnsafe<AccountRecord[]>(
        `SELECT * FROM "accounts" WHERE "emailVerificationTokenHash" = $1 LIMIT 1`,
        tokenHash,
      );
      return rows[0] ?? null;
    }
    return (this.prisma as PrismaWithAccount).account.findUnique({
      where: { emailVerificationTokenHash: tokenHash } as unknown as Record<string, unknown>,
    });
  }

  async update(id: string, patch: Partial<AccountRecord>): Promise<AccountRecord> {
    const now = new Date();

    if (hasRealRaw(this.prisma)) {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const [key, value] of Object.entries(patch)) {
        const column = key === 'googleId' ? 'googleId' : key === 'issuerDid' ? 'issuerDid' : key;
        setClauses.push(`"${column}" = $${i}`);
        values.push(value);
        i += 1;
      }
      setClauses.push(`"updatedAt" = $${i}`);
      values.push(now);
      values.push(id);
      const rows = await (this.prisma as PrismaRaw).$queryRawUnsafe<AccountRecord[]>(
        `UPDATE "accounts" SET ${setClauses.join(', ')} WHERE "id" = $${i + 1} RETURNING *`,
        ...values,
      );
      const row = rows[0];
      if (!row) throw new Error('Account update affected no rows');
      return row;
    }

    return (await (this.prisma as PrismaWithAccount).account.update({
      where: { id },
      data: patch,
    })) as AccountRecord;
  }
}

type SqliteAccountRow = {
  id: string;
  email: string;
  password_hash: string | null;
  google_id: string | null;
  issuer_did: string | null;
  email_verified_at: string | null;
  email_verification_token_hash: string | null;
  email_verification_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

function fromSqliteRow(row: SqliteAccountRow | undefined): AccountRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    googleId: row.google_id,
    issuerDid: row.issuer_did,
    emailVerifiedAt: row.email_verified_at ? new Date(row.email_verified_at) : null,
    emailVerificationTokenHash: row.email_verification_token_hash,
    emailVerificationExpiresAt: row.email_verification_expires_at
      ? new Date(row.email_verification_expires_at)
      : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class SqliteAccountStorageDriver implements AccountStorageDriver {
  constructor(private readonly sqlite: SqliteStore) {}

  async create(data: {
    email: string;
    passwordHash: string | null;
    googleId: string | null;
  }): Promise<AccountRecord> {
    const id = makeId();
    const now = new Date();
    this.sqlite.execute(`
      INSERT INTO accounts (
        id, email, password_hash, google_id, issuer_did,
        email_verified_at, email_verification_token_hash, email_verification_expires_at,
        created_at, updated_at
      )
      VALUES (
        ${sqliteLiteral(id)},
        ${sqliteLiteral(data.email)},
        ${sqliteLiteral(data.passwordHash)},
        ${sqliteLiteral(data.googleId)},
        NULL, NULL, NULL, NULL,
        ${sqliteLiteral(now)},
        ${sqliteLiteral(now)}
      )
    `);
    return {
      id,
      email: data.email,
      passwordHash: data.passwordHash,
      googleId: data.googleId,
      issuerDid: null,
      emailVerifiedAt: null,
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async findById(id: string): Promise<AccountRecord | null> {
    const rows = this.sqlite.query<SqliteAccountRow>(
      `SELECT * FROM accounts WHERE id = ${sqliteLiteral(id)} LIMIT 1`,
    );
    return fromSqliteRow(rows[0]);
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {
    const rows = this.sqlite.query<SqliteAccountRow>(
      `SELECT * FROM accounts WHERE email = ${sqliteLiteral(email)} LIMIT 1`,
    );
    return fromSqliteRow(rows[0]);
  }

  async findByGoogleId(googleId: string): Promise<AccountRecord | null> {
    const rows = this.sqlite.query<SqliteAccountRow>(
      `SELECT * FROM accounts WHERE google_id = ${sqliteLiteral(googleId)} LIMIT 1`,
    );
    return fromSqliteRow(rows[0]);
  }

  async findByEmailVerificationTokenHash(tokenHash: string): Promise<AccountRecord | null> {
    const rows = this.sqlite.query<SqliteAccountRow>(
      `SELECT * FROM accounts WHERE email_verification_token_hash = ${sqliteLiteral(tokenHash)} LIMIT 1`,
    );
    return fromSqliteRow(rows[0]);
  }

  async update(id: string, patch: Partial<AccountRecord>): Promise<AccountRecord> {
    const now = new Date();
    const setClauses: string[] = [];
    if (patch.googleId !== undefined) setClauses.push(`google_id = ${sqliteLiteral(patch.googleId)}`);
    if (patch.issuerDid !== undefined) setClauses.push(`issuer_did = ${sqliteLiteral(patch.issuerDid)}`);
    if (patch.passwordHash !== undefined)
      setClauses.push(`password_hash = ${sqliteLiteral(patch.passwordHash)}`);
    if (patch.emailVerifiedAt !== undefined)
      setClauses.push(`email_verified_at = ${sqliteLiteral(patch.emailVerifiedAt)}`);
    if (patch.emailVerificationTokenHash !== undefined)
      setClauses.push(
        `email_verification_token_hash = ${sqliteLiteral(patch.emailVerificationTokenHash)}`,
      );
    if (patch.emailVerificationExpiresAt !== undefined)
      setClauses.push(
        `email_verification_expires_at = ${sqliteLiteral(patch.emailVerificationExpiresAt)}`,
      );
    setClauses.push(`updated_at = ${sqliteLiteral(now)}`);
    this.sqlite.execute(
      `UPDATE accounts SET ${setClauses.join(', ')} WHERE id = ${sqliteLiteral(id)}`,
    );
    const updated = await this.findById(id);
    if (!updated) throw new Error('Account update affected no rows');
    return updated;
  }
}

export class InMemoryAccountStorageDriver implements AccountStorageDriver {
  private readonly rows = new Map<string, AccountRecord>();

  async create(data: {
    email: string;
    passwordHash: string | null;
    googleId: string | null;
  }): Promise<AccountRecord> {
    const id = makeId();
    const now = new Date();
    const record: AccountRecord = {
      id,
      email: data.email,
      passwordHash: data.passwordHash,
      googleId: data.googleId,
      issuerDid: null,
      emailVerifiedAt: null,
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, record);
    return record;
  }

  async findById(id: string): Promise<AccountRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {
    for (const record of this.rows.values()) {
      if (record.email === email) return record;
    }
    return null;
  }

  async findByGoogleId(googleId: string): Promise<AccountRecord | null> {
    for (const record of this.rows.values()) {
      if (record.googleId === googleId) return record;
    }
    return null;
  }

  async findByEmailVerificationTokenHash(tokenHash: string): Promise<AccountRecord | null> {
    for (const record of this.rows.values()) {
      if (record.emailVerificationTokenHash === tokenHash) return record;
    }
    return null;
  }

  async update(id: string, patch: Partial<AccountRecord>): Promise<AccountRecord> {
    const record = this.rows.get(id);
    if (!record) throw new Error('Account update affected no rows');
    const updated: AccountRecord = { ...record, ...patch, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }
}

export function createAccountStorageDriver(
  kind: StorageDriverKind,
  deps: StorageDriverDeps,
): AccountStorageDriver {
  switch (kind) {
    case 'postgres':
      if (!deps.prisma) throw new Error("createAccountStorageDriver('postgres') requires deps.prisma");
      return new PrismaAccountStorageDriver(deps.prisma as PrismaClient);
    case 'sqlite':
      if (!deps.sqlite) throw new Error("createAccountStorageDriver('sqlite') requires deps.sqlite");
      return new SqliteAccountStorageDriver(deps.sqlite as SqliteStore);
    case 'memory':
      return new InMemoryAccountStorageDriver();
    default: {
      const _exhaustive: never = kind;
      throw new UnsupportedStorageDriverError('AccountRepository', _exhaustive);
    }
  }
}
