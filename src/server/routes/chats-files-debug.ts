import { existsSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CardService } from '../../cards/card-api.js';
import { redactOperatorErrorMessage } from '../../workspace/index.js';
import { listRecentReviews } from '../../workspace/index.js';
import type { DoctorCheck, DoctorIssue, DoctorResponse } from '../../schemas/index.js';
import { cardRecordsRoot } from '../../persistence/card-loader.js';
import type { AuthPolicy } from '../auth-policy.js';

export function registerInternalDebugRoutes(fastify: FastifyInstance, projectRoot: string, store: CardService, authPolicy: AuthPolicy): void {
  const requireOperator = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (authPolicy.validateHttpRequest(request).ok) return;
    await reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
  };

  fastify.get('/api/debug/doctor', { preHandler: requireOperator }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const checks: DoctorCheck[] = [];
      const issues: DoctorIssue[] = [];

      try {
        store.list();
      } catch (err) {
        checks.push({ name: 'cards_loadable', passed: false, details: 'Cards failed to load.' });
        issues.push({ severity: 'error', message: `Cards failed to load: ${err instanceof Error ? err.message : String(err)}` });
        return reply.send({ status: 'issues_found', checks, issues } as DoctorResponse);
      }
      checks.push({ name: 'cards_loadable', passed: true, details: 'Cards loaded successfully.' });

      const allPassed = checks.every((c) => c.passed);
      return reply.send({ status: allPassed ? 'ok' : 'issues_found', checks, issues } as DoctorResponse);
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to run doctor consistency check', message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot) });
    }
  });

  fastify.get('/api/debug/supervision', { preHandler: requireOperator }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const reviews = listRecentReviews(projectRoot, 50);
      const byRisk: Record<string, number> = {};
      const bySourceKind: Record<string, number> = {};
      for (const r of reviews) {
        byRisk[r.risk] = (byRisk[r.risk] || 0) + 1;
        bySourceKind[r.source_kind] = (bySourceKind[r.source_kind] || 0) + 1;
      }
      return reply.send({
        reviews,
        stats: {
          total: reviews.length,
          blocked: reviews.filter((r) => r.status === 'blocked').length,
          passed: reviews.filter((r) => r.status === 'passed').length,
          sanitized: reviews.filter((r) => r.status === 'sanitized').length,
          byRisk,
          bySourceKind,
        },
      });
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to read supervision data', message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot) });
    }
  });
}
