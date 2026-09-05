// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// See docs/proposal-hosted-instance.md ("Decided: accounts, login, and
// DID/key custody"). Plain email/Google account table — deliberately not
// DID-specific, since there's no W3C standard for accounts/sessions.

import type { PrismaClient } from '@prisma/client';
import type { SqliteStore } from '../storage/sqlite.js';
import type { StorageDriverKind } from '../storage/driver-registry.js';
import { createAccountStorageDriver, type AccountStorageDriver } from './drivers/account.drivers.js';

export interface AccountRecord {
  id: string;
  email: string;
  passwordHash: string | null;
  googleId: string | null;
  issuerDid: string | null;
  companyName: string | null;
  fieldOfOperation: string | null;
  emailVerifiedAt: Date | null;
  emailVerificationTokenHash: string | null;
  emailVerificationExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * AccountRepository is a thin delegator over an AccountStorageDriver — see
 * storage/driver-registry.ts for the pattern and
 * repositories/drivers/did.drivers.ts for the reference implementation.
 * The (prisma?, sqlite?) constructor signature is unchanged on purpose —
 * see did.repository.ts's class doc comment for the full rationale.
 */
export class AccountRepository {
  private readonly driver: AccountStorageDriver;

  constructor(
    private readonly prisma?: PrismaClient,
    private readonly sqlite?: SqliteStore,
  ) {
    this.driver = createAccountStorageDriver(this.resolveDriverKind(), { prisma, sqlite });
  }

  private resolveDriverKind(): StorageDriverKind {
    if (this.prisma) return 'postgres';
    if (this.sqlite) return 'sqlite';
    return 'memory';
  }

  async create(data: {
    email: string;
    passwordHash: string | null;
    googleId: string | null;
    companyName?: string | null;
    fieldOfOperation?: string | null;
  }): Promise<AccountRecord> {
    return this.driver.create(data);
  }

  async findById(id: string): Promise<AccountRecord | null> {
    return this.driver.findById(id);
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {
    return this.driver.findByEmail(email);
  }

  async findByGoogleId(googleId: string): Promise<AccountRecord | null> {
    return this.driver.findByGoogleId(googleId);
  }

  /** Sets googleId on an account that registered with a password (account linking). */
  async linkGoogleId(id: string, googleId: string): Promise<AccountRecord> {
    return this.driver.update(id, { googleId });
  }

  /** Records the auto-provisioned issuer DID for this account (set once, at creation time). */
  async setIssuerDid(id: string, issuerDid: string): Promise<AccountRecord> {
    return this.driver.update(id, { issuerDid });
  }

  /** Stores a hashed, expiring email-verification token — see services/auth/email-verification.ts. */
  async setEmailVerificationToken(
    id: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<AccountRecord> {
    return this.driver.update(id, {
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: expiresAt,
    });
  }

  /** Marks the email verified and clears the (now-consumed) token. */
  async markEmailVerified(id: string): Promise<AccountRecord> {
    return this.driver.update(id, {
      emailVerifiedAt: new Date(),
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
    });
  }

  async findByEmailVerificationTokenHash(tokenHash: string): Promise<AccountRecord | null> {
    return this.driver.findByEmailVerificationTokenHash(tokenHash);
  }
}
