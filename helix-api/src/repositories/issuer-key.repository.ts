// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Stores AES-256-GCM-encrypted private keys for hosted-account issuer DIDs.
// See docs/proposal-hosted-instance.md ("Private key storage (interim,
// pre-KMS)"). Rows are only ever written/read through KeyCustody
// (services/auth/key-custody.ts) — never decrypted here.

import type { PrismaClient } from '@prisma/client';
import type { SqliteStore } from '../storage/sqlite.js';
import type { StorageDriverKind } from '../storage/driver-registry.js';
import {
  createIssuerKeyStorageDriver,
  type IssuerKeyStorageDriver,
} from './drivers/issuer-key.drivers.js';

export interface IssuerKeyRecordRow {
  id: string;
  accountId: string;
  did: string;
  encryptedPrivateKey: string;
  iv: string;
  authTag: string;
  algorithm: string;
  createdAt: Date;
}

/**
 * IssuerKeyRepository is a thin delegator over an IssuerKeyStorageDriver —
 * see storage/driver-registry.ts for the pattern and
 * repositories/drivers/did.drivers.ts for the reference implementation.
 * The (prisma?, sqlite?) constructor signature is unchanged on purpose —
 * see did.repository.ts's class doc comment for the full rationale.
 */
export class IssuerKeyRepository {
  private readonly driver: IssuerKeyStorageDriver;

  constructor(
    private readonly prisma?: PrismaClient,
    private readonly sqlite?: SqliteStore,
  ) {
    this.driver = createIssuerKeyStorageDriver(this.resolveDriverKind(), { prisma, sqlite });
  }

  private resolveDriverKind(): StorageDriverKind {
    if (this.prisma) return 'postgres';
    if (this.sqlite) return 'sqlite';
    return 'memory';
  }

  async create(data: Omit<IssuerKeyRecordRow, 'id' | 'createdAt'>): Promise<IssuerKeyRecordRow> {
    return this.driver.create(data);
  }

  async findByAccountId(accountId: string): Promise<IssuerKeyRecordRow | null> {
    return this.driver.findByAccountId(accountId);
  }
}
