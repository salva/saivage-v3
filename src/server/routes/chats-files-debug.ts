import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CardStore } from '../../cards/store-api.js';
import { redactOperatorErrorMessage } from '../../workspace/index.js';
import { listRecentReviews, listQuarantineIndex } from '../../workspace/index.js';
import type { DoctorCheck, DoctorIssue, DoctorResponse } from '../../schemas/index.js';
import { cardRecordVersionPath, cardRecordsRoot } from '../../persistence/card-loader.js';
import { readRecordSlotIndex } from '../../runtime/records/record-slots.js';

export const internalDebugRoutes = [
  { method: 'GET', path: '/api/debug/doctor' },
  { method: 'GET', path: '/api/debug/supervision' },
] as const;

export function registerInternalDebugRoutes(fastify: FastifyInstance, projectRoot: string, store: CardStore): void {
  const saivageDir = join(projectRoot, '.saivage');

  fastify.get('/api/debug/doctor', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const cardRecordsDir = cardRecordsRoot(projectRoot);
      const checks: DoctorCheck[] = [];
      const issues: DoctorIssue[] = [];

      let diskCardIds: Set<string> = new Set();
      let cardRecordsExist = false;
      if (existsSync(cardRecordsDir)) {
        cardRecordsExist = true;
        try {
          const dirs = readdirSync(cardRecordsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
          diskCardIds = new Set(dirs.filter((entry) => {
            const index = readRecordSlotIndex(projectRoot, entry.name, 'card');
            return index.latest !== null && existsSync(cardRecordVersionPath(projectRoot, entry.name, index.latest));
          }).map((entry) => entry.name));
        } catch { void 0; }
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

  fastify.get('/api/debug/supervision', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const reviews = listRecentReviews(saivageDir, 50);
      const quarantineIndex = listQuarantineIndex(saivageDir);
      const byRisk: Record<string, number> = {};
      const bySourceKind: Record<string, number> = {};
      for (const r of reviews) {
        byRisk[r.risk] = (byRisk[r.risk] || 0) + 1;
        bySourceKind[r.source_kind] = (bySourceKind[r.source_kind] || 0) + 1;
      }
      return reply.send({
        reviews,
        quarantine: quarantineIndex.map((entry) => ({ quarantine_id: entry.quarantine_id, review_id: entry.review_id, source_ref: entry.source_ref, risk: entry.risk, created_at: entry.created_at })),
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
