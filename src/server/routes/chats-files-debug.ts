import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CardService } from '../../cards/card-api.js';
import { UNEXPECTED_INTERNAL_SERVER_ERROR } from '../../contracts/index.js';
import type { DoctorCheck, DoctorIssue, DoctorResponse } from '../../schemas/index.js';
import type { AuthPolicy } from '../auth-policy.js';

export function registerInternalDebugRoutes(fastify: FastifyInstance, _projectRoot: string, store: CardService, authPolicy: AuthPolicy): void {
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
}
