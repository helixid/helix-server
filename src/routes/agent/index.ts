// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Wraps @helixid/core's AgentService with hosted-account attribution. Core
// has no accountId column on EnrollmentToken/Challenge/Vc, so this tracks
// "which account does this enrollment token belong to" (and, transitively,
// the challenge and the VC it eventually produces) in enterprise's own side
// tables (repositories/account-links.repository.ts), keyed by the same
// tokenHash core computes internally — hashToken() is exported from
// @helixid/core specifically so this file can derive the identical key
// independently, without core ever returning an internal row id.

import type { FastifyPluginAsync } from 'fastify';
import { hashToken, mapAgentError, type AuditEventType, type IAgentService } from '@helixid/core';
import {
  resolveAccountOrAdmin,
  type AccountOrAdminGuardDeps,
} from '../../services/auth/account-or-admin-guard.js';
import { ACCOUNT_QUOTA_EVENTS } from '../../services/auth/quota.js';
import type { AccountLinkRepository } from '../../repositories/account-links.repository.js';
import type { IAuditLogger } from '@helixid/core';

interface AgentRouteOptions {
  agentService: IAgentService;
  /** Enables hosted-account bearer-token enrollment-token generation, quota- and verification-gated. Omit to preserve the original open (no-auth) behavior. */
  accountOrAdminGuardDeps?: AccountOrAdminGuardDeps | undefined;
  /** Required alongside accountOrAdminGuardDeps — see docs/proposal-hosted-rate-limiting.md. */
  enrollmentTokenDailyQuota?: number | undefined;
  /** Required alongside accountOrAdminGuardDeps, to track token/challenge/VC -> accountId ownership. */
  enrollmentTokenAccountLinkRepository?: AccountLinkRepository | undefined;
  challengeAccountLinkRepository?: AccountLinkRepository | undefined;
  vcAccountLinkRepository?: AccountLinkRepository | undefined;
  auditLogger?: IAuditLogger | undefined;
}

const agentRoutes: FastifyPluginAsync<AgentRouteOptions> = async (fastify, options) => {
  fastify.post('/enrollment-tokens', async (request, reply) => {
    try {
      let accountId: string | undefined;
      if (options.accountOrAdminGuardDeps) {
        // Admin key, a verified+under-quota hosted-account bearer token, or
        // no auth at all are all accepted here (requireAuth: false)
        // deliberately — this route had no gate before hosted accounts
        // existed, and that self-hosted behavior is preserved. A bearer
        // token, if present, still gets the quota + verification checks.
        const result = await resolveAccountOrAdmin(request, options.accountOrAdminGuardDeps, {
          requireAuth: false,
          quota: options.enrollmentTokenDailyQuota
            ? {
                eventType: ACCOUNT_QUOTA_EVENTS.ENROLLMENT_TOKEN_GENERATED,
                dailyLimit: options.enrollmentTokenDailyQuota,
              }
            : undefined,
        });
        accountId = result.accountId;
      }

      const body = request.body as {
        agentName: string;
        requestedScopes: string[];
        requestedDomains?: string[];
        maxDelegationDepth?: number;
      };
      const result = await options.agentService.generateEnrollmentToken(body, request.id);
      if (accountId) {
        const tokenHash = hashToken(result.token);
        await options.enrollmentTokenAccountLinkRepository!.link(tokenHash, accountId);
        options.auditLogger?.log(ACCOUNT_QUOTA_EVENTS.ENROLLMENT_TOKEN_GENERATED as AuditEventType, {
          requestId: request.id,
          accountId,
          tokenIdHash: tokenHash,
        });
      }
      return reply.code(201).send(result);
    } catch (error) {
      const mapped = mapAgentError(error);
      return reply
        .code(mapped.statusCode)
        .send({ error: { code: mapped.code, message: mapped.message, requestId: request.id } });
    }
  });

  fastify.post('/enroll', async (request, reply) => {
    try {
      const body = request.body as {
        bootstrapToken: string;
        agentDid: string;
        timestamp: number;
        proofSignature: string;
      };
      const accountId = options.enrollmentTokenAccountLinkRepository
        ? await options.enrollmentTokenAccountLinkRepository.getAccountId(hashToken(body.bootstrapToken))
        : null;
      const result = await options.agentService.enroll(body, request.id);
      if (accountId) {
        await options.vcAccountLinkRepository!.link(result.vcId, accountId);
      }
      return reply.code(201).send(result);
    } catch (error) {
      const mapped = mapAgentError(error);
      return reply
        .code(mapped.statusCode)
        .send({ error: { code: mapped.code, message: mapped.message, requestId: request.id } });
    }
  });

  fastify.post('/onboard', async (request, reply) => {
    try {
      const body = request.body as { enrollmentToken: string; publicKeyHex: string; domains?: string[] };
      const accountId = options.enrollmentTokenAccountLinkRepository
        ? await options.enrollmentTokenAccountLinkRepository.getAccountId(hashToken(body.enrollmentToken))
        : null;
      const result = await options.agentService.processOnboardStep1(body, request.id);
      if (accountId) {
        await options.challengeAccountLinkRepository!.link(result.challengeId, accountId);
      }
      return reply.code(200).send(result);
    } catch (error) {
      const mapped = mapAgentError(error);
      return reply
        .code(mapped.statusCode)
        .send({ error: { code: mapped.code, message: mapped.message, requestId: request.id } });
    }
  });

  fastify.post('/onboard/verify', async (request, reply) => {
    try {
      const body = request.body as { challengeId: string; signature: string; didCreateSignature?: string };
      const accountId = options.challengeAccountLinkRepository
        ? await options.challengeAccountLinkRepository.getAccountId(body.challengeId)
        : null;
      const result = await options.agentService.processOnboardVerify(body, request.id);
      if (accountId) {
        await options.vcAccountLinkRepository!.link(result.vcId, accountId);
      }
      return reply.code(201).send(result);
    } catch (error) {
      const mapped = mapAgentError(error);
      return reply
        .code(mapped.statusCode)
        .send({ error: { code: mapped.code, message: mapped.message, requestId: request.id } });
    }
  });

  fastify.post('/challenges', async (request, reply) => {
    try {
      const result = await options.agentService.issueUserChallenge(
        request.body as { did: string; purpose: 'user_verification' },
        request.id,
      );
      return reply.code(201).send(result);
    } catch (error) {
      const mapped = mapAgentError(error);
      return reply
        .code(mapped.statusCode)
        .send({ error: { code: mapped.code, message: mapped.message, requestId: request.id } });
    }
  });

  fastify.post('/challenges/:challengeId/verify', async (request, reply) => {
    try {
      const params = request.params as { challengeId: string };
      const body = request.body as { signature: string };
      const result = await options.agentService.verifyUserChallenge(
        params.challengeId,
        body,
        request.id,
      );
      return reply.code(200).send(result);
    } catch (error) {
      const mapped = mapAgentError(error);
      return reply
        .code(mapped.statusCode)
        .send({ error: { code: mapped.code, message: mapped.message, requestId: request.id } });
    }
  });
};

export default agentRoutes;
