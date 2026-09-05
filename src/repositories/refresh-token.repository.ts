// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// See docs/proposal-hosted-instance.md ("Sessions: access + refresh
// tokens"). Refresh tokens are opaque, stored hashed, and rotated on every
// use; `replacedByTokenId` forms a chain that AuthService.refresh() walks
// to detect reuse of an already-revoked token (compromise signal).

import type { PrismaClient } from '@prisma/client';
import type { SqliteStore, StorageDriverKind } from '@helixid/core';
import {
  createRefreshTokenStorageDriver,
  type RefreshTokenStorageDriver,
} from './drivers/refresh-token.drivers.js';

export interface RefreshTokenRecord {
  id: string;
  accountId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByTokenId: string | null;
  createdAt: Date;
}

/**
 * RefreshTokenRepository is a thin delegator over a
 * RefreshTokenStorageDriver — see storage/driver-registry.ts for the
 * pattern and repositories/drivers/did.drivers.ts for the reference
 * implementation. The (prisma?, sqlite?) constructor signature is
 * unchanged on purpose — see did.repository.ts's class doc comment for
 * the full rationale.
 */
export class RefreshTokenRepository {
  private readonly driver: RefreshTokenStorageDriver;

  constructor(
    private readonly prisma?: PrismaClient,
    private readonly sqlite?: SqliteStore,
  ) {
    this.driver = createRefreshTokenStorageDriver(this.resolveDriverKind(), { prisma, sqlite });
  }

  private resolveDriverKind(): StorageDriverKind {
    if (this.prisma) return 'postgres';
    if (this.sqlite) return 'sqlite';
    return 'memory';
  }

  async create(data: {
    accountId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshTokenRecord> {
    return this.driver.create(data);
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return this.driver.findByTokenHash(tokenHash);
  }

  /** Marks a token revoked and, if rotated rather than just logged out, links it to its successor. */
  async revoke(id: string, replacedByTokenId?: string): Promise<void> {
    return this.driver.revoke(id, replacedByTokenId);
  }

  /** Reuse-detection response: revoke every outstanding refresh token for an account. */
  async revokeAllForAccount(accountId: string): Promise<void> {
    return this.driver.revokeAllForAccount(accountId);
  }
}
