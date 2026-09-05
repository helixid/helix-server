// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// See docs/proposal-hosted-rate-limiting.md ("Per-account quotas") — locked
// values: VC issuance 1000/day, enrollment token generation 2000/day.
// Counts existing audit log rows for the account in a rolling 24h window.
//
// helix-core's audit log has no accountId column and its own VC_ISSUED /
// ENROLLMENT_TOKEN_GENERATED events never carry one — core has no concept
// of accounts. So the routes that gate on a quota (see routes/vc,
// routes/agent) log a *second*, enterprise-only event of their own
// (ACCOUNT_VC_ISSUED / ACCOUNT_ENROLLMENT_TOKEN_GENERATED, with accountId in
// the payload) through the same injected auditLogger, and this scans for
// those. That means an unindexed payload scan rather than an indexed column
// lookup — accepted, since there's no column on a core-owned table to index
// without forking helix-core's schema.
import { AccountQuotaExceededError, type AuditLogRepository } from '@helixid/core';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const ACCOUNT_QUOTA_EVENTS = {
  VC_ISSUED: 'ACCOUNT_VC_ISSUED',
  ENROLLMENT_TOKEN_GENERATED: 'ACCOUNT_ENROLLMENT_TOKEN_GENERATED',
} as const;

export interface QuotaCheckOptions {
  auditLogRepository: AuditLogRepository;
  accountId: string;
  eventType: string;
  dailyLimit: number;
}

/**
 * Throws AccountQuotaExceededError if the account has hit its daily limit
 * for the given event type.
 */
export async function assertUnderDailyQuota(options: QuotaCheckOptions): Promise<void> {
  const { auditLogRepository, accountId, eventType, dailyLimit } = options;
  const since = new Date(Date.now() - ONE_DAY_MS);

  const rows = await auditLogRepository.list({ eventType, since, limit: 100_000 });
  const countForAccount = rows.filter((row) => row.payload['accountId'] === accountId).length;

  if (countForAccount >= dailyLimit) {
    throw new AccountQuotaExceededError(
      `Daily limit of ${dailyLimit} for ${eventType} reached for this account. Try again after ${new Date(
        Date.now() + ONE_DAY_MS,
      ).toISOString()}.`,
    );
  }
}

export async function assertUnderVcIssuanceQuota(
  auditLogRepository: AuditLogRepository,
  accountId: string,
  dailyLimit: number,
): Promise<void> {
  return assertUnderDailyQuota({
    auditLogRepository,
    accountId,
    eventType: ACCOUNT_QUOTA_EVENTS.VC_ISSUED,
    dailyLimit,
  });
}

export async function assertUnderEnrollmentTokenQuota(
  auditLogRepository: AuditLogRepository,
  accountId: string,
  dailyLimit: number,
): Promise<void> {
  return assertUnderDailyQuota({
    auditLogRepository,
    accountId,
    eventType: ACCOUNT_QUOTA_EVENTS.ENROLLMENT_TOKEN_GENERATED,
    dailyLimit,
  });
}
