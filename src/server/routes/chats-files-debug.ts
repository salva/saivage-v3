import { existsSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CardStoreRepository } from '../../cards/store-api.js';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import { redactOperatorErrorMessage } from '../../workspace/index.js';
import { listRecentReviews } from '../../workspace/index.js';
import type { DoctorCheck, DoctorIssue, DoctorResponse } from '../../schemas/index.js';
import { cardRecordsRoot } from '../../persistence/card-loader.js';
import type { AuthPolicy } from '../auth-policy.js';

export function registerInternalDebugRoutes(fastify: FastifyInstance, projectRoot: string, store: CardStoreRepository, authPolicy: AuthPolicy, runtimeApplication?: RuntimeApplication): void {
  const requireOperator = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (authPolicy.validateHttpRequest(request).ok) return;
    await reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
  };
  fastify.post('/api/debug/runtime/start', { preHandler: requireOperator }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      if (!runtimeApplication) return reply.status(503).send({ error: 'Runtime application unavailable.' });
      return reply.send(await runtimeApplication.runtimeApi.startProject('operator'));
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to start runtime', message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot) });
    }
  });

  fastify.get('/api/debug/doctor', { preHandler: requireOperator }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const cardRecordsDir = cardRecordsRoot(projectRoot);
      const checks: DoctorCheck[] = [];
      const issues: DoctorIssue[] = [];

      let diskCardIds: Set<string> = new Set();
      let cardRecordsExist = false;
      if (existsSync(cardRecordsDir)) {
        cardRecordsExist = true;
        try {
          diskCardIds = new Set(store.recordReader.generation().cards.keys());
        } catch (err) {
          if (!(err instanceof Error) || !('code' in err) || err.code !== 'ENOENT') throw err;
        }
      }

      try {
        store.list();
      } catch (err) {
        checks.push({ name: 'cardstore_loadable', passed: false, details: 'CardStore failed to load.' });
        issues.push({ severity: 'error', message: `CardStore failed to load: ${err instanceof Error ? err.message : String(err)}` });
        return reply.send({ status: 'issues_found', checks, issues } as DoctorResponse);
      }
      checks.push({ name: 'cardstore_loadable', passed: true, details: 'CardStore loaded successfully.' });

      const storeCards = store.list();
      const storeIds = new Set(storeCards.map((c) => c.id));

      const missingFromDisk: string[] = [];
      for (const id of storeIds) if (!diskCardIds.has(id)) missingFromDisk.push(id);
      if (missingFromDisk.length > 0) {
        checks.push({ name: 'cardstore_entries_have_files', passed: false, details: `${missingFromDisk.length} CardStore entr${missingFromDisk.length === 1 ? 'y' : 'ies'} missing file(s) on disk: ${missingFromDisk.join(', ')}` });
        for (const id of missingFromDisk) issues.push({ severity: 'error', message: `CardStore entry '${id}' has no corresponding latest card.json record.` });
      } else {
        checks.push({ name: 'cardstore_entries_have_files', passed: true, details: cardRecordsExist ? `All ${storeIds.size} CardStore entr${storeIds.size === 1 ? 'y has' : 'ies have'} corresponding card.json records.` : 'No card record directory exists — no card records to check.' });
      }

      const orphanFiles: string[] = [];
      for (const id of diskCardIds) if (!storeIds.has(id)) orphanFiles.push(id);
      if (orphanFiles.length > 0) {
        checks.push({ name: 'card_files_have_cardstore_entries', passed: false, details: `${orphanFiles.length} card file(s) have no corresponding CardStore entry: ${orphanFiles.join(', ')}` });
        for (const id of orphanFiles) issues.push({ severity: 'error', message: `Card record namespace '${id}' has no corresponding CardStore entry.` });
      } else {
        checks.push({ name: 'card_files_have_cardstore_entries', passed: true, details: cardRecordsExist ? `All ${diskCardIds.size} card record namespace(s) have corresponding CardStore entries.` : 'No card record directory exists — no card records to check.' });
      }

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
