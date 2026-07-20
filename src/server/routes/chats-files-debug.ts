import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CardService } from '../../cards/card-api.js';
import { listRecentReviews } from '../../workspace/index.js';
import { UNEXPECTED_INTERNAL_SERVER_ERROR } from '../../contracts/index.js';
import type { DoctorCheck, DoctorIssue, DoctorResponse } from '../../schemas/index.js';
import type { AuthPolicy } from '../auth-policy.js';

export function registerInternalDebugRoutes(fastify: FastifyInstance, projectRoot: string, store: CardService, authPolicy: AuthPolicy): void {
  fastify.get('/api/debug/doctor', async (request: FastifyRequest, reply: FastifyReply) => {
    let failureCode = 'auth_evaluation_failed';
    let final: { statusCode: number; body: unknown };
    try {
      const auth = authPolicy.validateHttpRequest(request);
      if (!auth.ok) {
        final = { statusCode: 401, body: { error: 'Unauthorized', statusCode: 401 } };
      } else {
        failureCode = 'doctor_failed';
        const checks: DoctorCheck[] = [];
        const issues: DoctorIssue[] = [];

        try {
          store.list();
          checks.push({ name: 'cards_loadable', passed: true, details: 'Cards loaded successfully.' });
        } catch {
          request.log.error(
            { operation: 'debug.doctor', failureCode: 'cards_load_failed' },
            'Operator Doctor card check failed',
          );
          checks.push({ name: 'cards_loadable', passed: false, details: 'Cards failed to load.' });
          issues.push({ severity: 'error', message: 'Cards failed to load.' });
        }

        const allPassed = checks.every((check) => check.passed);
        final = {
          statusCode: 200,
          body: { status: allPassed ? 'ok' : 'issues_found', checks, issues } as DoctorResponse,
        };
      }
    } catch {
      request.log.error(
        { operation: 'debug.doctor', failureCode },
        'Operator Doctor operation failed',
      );
      final = { statusCode: 500, body: UNEXPECTED_INTERNAL_SERVER_ERROR };
    }
    return reply.status(final.statusCode).send(final.body);
  });

  fastify.get('/api/debug/supervision', async (request: FastifyRequest, reply: FastifyReply) => {
    let failureCode = 'auth_evaluation_failed';
    let final: { statusCode: number; body: unknown };
    try {
      const auth = authPolicy.validateHttpRequest(request);
      if (!auth.ok) {
        final = { statusCode: 401, body: { error: 'Unauthorized', statusCode: 401 } };
      } else {
        failureCode = 'supervision_read_failed';
        const reviews = listRecentReviews(projectRoot, 50);
        const byRisk: Record<string, number> = {};
        const bySourceKind: Record<string, number> = {};
        for (const review of reviews) {
          byRisk[review.risk] = (byRisk[review.risk] || 0) + 1;
          bySourceKind[review.source_kind] = (bySourceKind[review.source_kind] || 0) + 1;
        }
        final = {
          statusCode: 200,
          body: {
            reviews,
            stats: {
              total: reviews.length,
              blocked: reviews.filter((review) => review.status === 'blocked').length,
              passed: reviews.filter((review) => review.status === 'passed').length,
              sanitized: reviews.filter((review) => review.status === 'sanitized').length,
              byRisk,
              bySourceKind,
            },
          },
        };
      }
    } catch {
      request.log.error(
        { operation: 'debug.supervision', failureCode },
        'Operator Supervision operation failed',
      );
      final = { statusCode: 500, body: UNEXPECTED_INTERNAL_SERVER_ERROR };
    }
    return reply.status(final.statusCode).send(final.body);
  });
}
