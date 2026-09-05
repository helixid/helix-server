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
// Wraps @helixid/core's VCService with hosted-account auth/scoping. Core's
// Vc table carries no accountId column (core has no concept of accounts),
// so ownership is tracked here instead, in the vc_account_links side table
// (see repositories/account-links.repository.ts), keyed by vcId — which
// core's issueVC()/getVC() already return/accept without needing to know
// why the caller cares about it.

import { FastifyPluginAsync } from 'fastify';
import {
  AdminAuthRequiredError,
  ErrorCode,
  HelixError,
  type AuditEventType,
  type IVCService,
  type IssueVCParams,
  type RenewVCOptions,
} from '@helixid/core';
import {
  resolveAccountOrAdmin,
  type AccountOrAdminGuardDeps,
} from '../../services/auth/account-or-admin-guard.js';
import { ACCOUNT_QUOTA_EVENTS } from '../../services/auth/quota.js';
import type { AccountLinkRepository } from '../../repositories/account-links.repository.js';
import type { IAuditLogger } from '@helixid/core';

const VC_STATUSES = ['active', 'revoked', 'expired'] as const;
type VCStatus = (typeof VC_STATUSES)[number];

export interface VcRouteOptions {
  vcService: IVCService;
  adminApiKey?: string | undefined;
  /** Enables hosted-account bearer-token issuance (in addition to the admin key) when provided. */
  accountOrAdminGuardDeps?: AccountOrAdminGuardDeps | undefined;
  /** Required alongside accountOrAdminGuardDeps — see docs/proposal-hosted-rate-limiting.md. */
  vcIssuanceDailyQuota?: number | undefined;
  /** Required alongside accountOrAdminGuardDeps, to record/read vcId -> accountId ownership. */
  vcAccountLinkRepository?: AccountLinkRepository | undefined;
  auditLogger?: IAuditLogger | undefined;
}

interface VCParams {
  vcId: string;
}

/**
 * VC API Route Definitions (Boundary 2).
 */
const vcRoutes: FastifyPluginAsync<VcRouteOptions> = async (fastify, options) => {
  const { vcService, adminApiKey } = options;

  function requireAdmin(request: { headers: Record<string, string | string[] | undefined> }): void {
    const submitted = request.headers['x-admin-api-key'];
    const submittedKey = Array.isArray(submitted) ? submitted[0] : submitted;
    if (!adminApiKey || submittedKey !== adminApiKey) {
      throw new AdminAuthRequiredError();
    }
  }

  // GET /v1/vcs - List VC summaries. Admin key sees everything (unchanged);
  // a hosted-account bearer token sees only VCs issued for that account.
  fastify.get('', async (request, reply) => {
    let accountId: string | undefined;
    if (options.accountOrAdminGuardDeps) {
      const result = await resolveAccountOrAdmin(request, options.accountOrAdminGuardDeps, {
        requireAuth: true,
      });
      accountId = result.accountId;
    } else {
      requireAdmin(request);
    }

    const query = request.query as { subjectDid?: string; status?: string; limit?: string };
    if (query.status && !(VC_STATUSES as readonly string[]).includes(query.status)) {
      throw new HelixError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid status filter: ${query.status}`,
        400,
      );
    }
    const limit = query.limit === undefined ? undefined : Number.parseInt(query.limit, 10);
    if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
      throw new HelixError(ErrorCode.VALIDATION_ERROR, `Invalid limit: ${query.limit}`, 400);
    }
    const result = await vcService.listVCs({
      subjectDid: query.subjectDid,
      status: query.status as VCStatus | undefined,
      limit,
    });

    if (!accountId) {
      return reply.send(result);
    }
    const ownedVcIds = new Set(await options.vcAccountLinkRepository!.listKeysForAccount(accountId));
    return reply.send(result.filter((summary) => ownedVcIds.has(summary.vcId)));
  });

  // POST /v1/vcs - Issue a VC
  fastify.post('', async (request, reply) => {
    let accountId: string | undefined;
    if (options.accountOrAdminGuardDeps) {
      // Hosted mode: admin key OR a verified, under-quota hosted-account
      // bearer token may issue. Self-hosted (no accountOrAdminGuardDeps
      // configured) keeps the original admin-key-only behavior untouched.
      const result = await resolveAccountOrAdmin(request, options.accountOrAdminGuardDeps, {
        requireAuth: true,
        quota: options.vcIssuanceDailyQuota
          ? { eventType: ACCOUNT_QUOTA_EVENTS.VC_ISSUED, dailyLimit: options.vcIssuanceDailyQuota }
          : undefined,
      });
      accountId = result.accountId;
    } else {
      requireAdmin(request);
    }

    const params = request.body as IssueVCParams;
    const result = await vcService.issueVC(params, request.id);
    if (accountId) {
      await options.vcAccountLinkRepository!.link(result.vcId, accountId);
      options.auditLogger?.log(ACCOUNT_QUOTA_EVENTS.VC_ISSUED as AuditEventType, {
        requestId: request.id,
        accountId,
        vcId: result.vcId,
      });
    }
    return reply.status(201).send(result);
  });

  // GET /v1/vcs/:vcId - Get VC details
  fastify.get('/:vcId', async (request, reply) => {
    const { vcId } = request.params as VCParams;
    const result = await vcService.getVC(vcId, request.id);
    return reply.send(result);
  });

  // GET /v1/vcs/:vcId/status - Get VC status only (active/revoked/expired)
  fastify.get('/:vcId/status', async (request, reply) => {
    const { vcId } = request.params as VCParams;
    const status = await vcService.getVCStatus(vcId);
    return reply.send({ vcId, status });
  });

  // POST /v1/vcs/:vcId/revoke - Revoke a VC. Admin key may revoke anything
  // (unchanged); a hosted-account bearer token may only revoke a VC issued
  // for that same account.
  fastify.post('/:vcId/revoke', async (request, reply) => {
    const { vcId } = request.params as VCParams;
    if (options.accountOrAdminGuardDeps) {
      const { accountId } = await resolveAccountOrAdmin(request, options.accountOrAdminGuardDeps, {
        requireAuth: true,
      });
      if (accountId) {
        const owner = await options.vcAccountLinkRepository!.getAccountId(vcId);
        if (owner !== accountId) {
          throw new HelixError(ErrorCode.VC_NOT_FOUND, 'Credential not found', 404);
        }
      }
    } else {
      requireAdmin(request);
    }
    const result = await vcService.revokeVC(vcId, request.id);
    return reply.send(result);
  });

  // POST /v1/vcs/:vcId/renew - Renew a VC
  fastify.post('/:vcId/renew', async (request, reply) => {
    requireAdmin(request);
    const { vcId } = request.params as VCParams;
    const overrides = request.body as RenewVCOptions;
    const result = await vcService.renewVC(vcId, overrides, request.id);
    return reply.status(201).send(result);
  });
};

export default vcRoutes;
