import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CardStore } from '../../cards/index.js';
import {
  redactOperatorErrorMessage,
} from '../../workspace/index.js';
import { GLOBAL_ANALYST_SESSION_ID, getAnalystHandler, resetAnalystHandlerCache } from '../../agents/index.js';
import {
  listRecentReviews,
  listQuarantineIndex,
} from '../../workspace/index.js';
import type { ActiveRuntime } from '../../runtime/index.js';
import type {
  DoctorCheck,
  DoctorIssue,
  DoctorResponse,
} from '../../schemas/index.js';
import { ChatReadModelService, DebugReadModelService, WorkspaceFileReadModelService, isSafeChatSessionId } from '../../application/read-models/index.js';

interface ChatWorkspaceContext {
  view: string | null;
  entityId: string | null;
  refinement: Record<string, string> | null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');
}

function validateWorkspaceContext(value: unknown): { ok: true; value: ChatWorkspaceContext } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'workspaceContext must be an object.' };
  }
  const ctx = value as Record<string, unknown>;
  if (!(ctx.view === null || typeof ctx.view === 'string')) {
    return { ok: false, error: 'workspaceContext.view must be a string or null.' };
  }
  if (!(ctx.entityId === null || typeof ctx.entityId === 'string')) {
    return { ok: false, error: 'workspaceContext.entityId must be a string or null.' };
  }
  if (!(ctx.refinement === null || isStringRecord(ctx.refinement))) {
    return { ok: false, error: 'workspaceContext.refinement must be an object with string values or null.' };
  }
  return {
    ok: true,
    value: {
      view: ctx.view,
      entityId: ctx.entityId,
      refinement: ctx.refinement,
    } as ChatWorkspaceContext,
  };
}

export function resetChatRouteState(projectRoot?: string): void {
  resetAnalystHandlerCache(projectRoot);
}

export function registerChatsFilesDebugRoutes(
  fastify: FastifyInstance,
  projectRoot: string,
  activeRuntime?: ActiveRuntime,
): void {
  const saivageDir = join(projectRoot, '.saivage');
  const chatReadModel = new ChatReadModelService(projectRoot);
  const fileReadModel = new WorkspaceFileReadModelService(projectRoot);
  const debugReadModel = new DebugReadModelService(projectRoot);

  fastify.addHook('onClose', async () => {
    resetChatRouteState(projectRoot);
  });

  fastify.get('/api/chats', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = chatReadModel.listSessions();
      return reply.status(result.statusCode ?? 200).send(result.body);
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to list chat sessions',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.get('/api/chats/:sessionId', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { sessionId: string };
      const result = chatReadModel.getMessages(params.sessionId);
      return reply.status(result.statusCode ?? 200).send(result.body);
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read session messages',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.post('/api/chats/:sessionId', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { sessionId: string };
      const sessionId = params.sessionId;
      const body = request.body as { content?: string; workspaceContext?: unknown };

      if (!isSafeChatSessionId(sessionId)) {
        return reply.status(400).send({ error: 'Invalid session ID format.', sessionId });
      }
      if (sessionId !== GLOBAL_ANALYST_SESSION_ID) {
        return reply.status(404).send({ error: 'Only the canonical analyst chat is available.', sessionId });
      }

      if (!body.content) {
        return reply.status(400).send({ error: 'Message content is required' });
      }

      let workspaceContext: ChatWorkspaceContext | undefined;
      if (body.workspaceContext !== undefined) {
        const validation = validateWorkspaceContext(body.workspaceContext);
        if (!validation.ok) {
          return reply.status(400).send({ error: validation.error });
        }
        workspaceContext = validation.value;
      }

      const handler = getAnalystHandler(projectRoot, { activeRuntime, surface: 'web-chat' });
      const response = await handler.handleMessage(GLOBAL_ANALYST_SESSION_ID, body.content, workspaceContext);

      return reply.send({
        sessionId: response.sessionId,
        message: response.message,
        toolInvocations: response.toolInvocations ?? [],
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to process chat message',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.get('/api/files', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as { path?: string };
      const result = fileReadModel.listFiles(query.path || '.');
      return reply.status(result.statusCode ?? 200).send(result.body);
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to list directory',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.get('/api/files/content', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as { path?: string };
      const result = fileReadModel.readFileContent(query.path);
      return reply.status(result.statusCode ?? 200).send(result.body);
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read file',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.get('/api/debug/state', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send(debugReadModel.getState());
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to dump debug state',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.get('/api/debug/errors', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send(debugReadModel.getErrors());
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read errors',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.get('/api/debug/timeline', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send(debugReadModel.getTimeline());
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read timeline',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.get('/api/debug/doctor', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const byIdDir = join(projectRoot, '.saivage', 'cards', 'by-id');
      const checks: DoctorCheck[] = [];
      const issues: DoctorIssue[] = [];

      let diskCardIds: Set<string> = new Set();
      let byIdExists = false;
      if (existsSync(byIdDir)) {
        byIdExists = true;
        try {
          const files = readdirSync(byIdDir).filter((f: string) => f.endsWith('.json'));
          diskCardIds = new Set(files.map((f: string) => f.replace('.json', '')));
        } catch { void 0; }
      }

      let store: CardStore | null = null;
      try {
        store = new CardStore(projectRoot);
      } catch (err) {
        checks.push({ name: 'cardstore_loadable', passed: false, details: 'CardStore failed to load.' });
        issues.push({ severity: 'error', message: `CardStore failed to load: ${err instanceof Error ? err.message : String(err)}` });
        return reply.send({ status: 'issues_found', checks, issues } as DoctorResponse);
      }
      checks.push({ name: 'cardstore_loadable', passed: true, details: 'CardStore loaded successfully.' });

      const storeCards = store.list();
      const storeIds = new Set(storeCards.map((c) => c.id));

      const missingFromDisk: string[] = [];
      for (const id of storeIds) {
        if (!diskCardIds.has(id)) missingFromDisk.push(id);
      }
      if (missingFromDisk.length > 0) {
        checks.push({ name: 'cardstore_entries_have_files', passed: false, details: `${missingFromDisk.length} CardStore entr${missingFromDisk.length === 1 ? 'y' : 'ies'} missing file(s) on disk: ${missingFromDisk.join(', ')}` });
        for (const id of missingFromDisk) {
          issues.push({ severity: 'error', message: `CardStore entry '${id}' has no corresponding file at .saivage/cards/by-id/${id}.json` });
        }
      } else {
        checks.push({ name: 'cardstore_entries_have_files', passed: true, details: byIdExists ? `All ${storeIds.size} CardStore entr${storeIds.size === 1 ? 'y has' : 'ies have'} corresponding files.` : 'No by-id/ directory exists — no card files to check.' });
      }

      const orphanFiles: string[] = [];
      for (const id of diskCardIds) {
        if (!storeIds.has(id)) orphanFiles.push(id);
      }
      if (orphanFiles.length > 0) {
        checks.push({ name: 'card_files_have_cardstore_entries', passed: false, details: `${orphanFiles.length} card file(s) have no corresponding CardStore entry: ${orphanFiles.join(', ')}` });
        for (const id of orphanFiles) {
          issues.push({ severity: 'error', message: `Card file .saivage/cards/by-id/${id}.json has no corresponding CardStore entry.` });
        }
      } else {
        checks.push({ name: 'card_files_have_cardstore_entries', passed: true, details: byIdExists ? `All ${diskCardIds.size} card file(s) have corresponding CardStore entries.` : 'No by-id/ directory exists — no card files to check.' });
      }

      const allPassed = checks.every((c) => c.passed);
      return reply.send({ status: allPassed ? 'ok' : 'issues_found', checks, issues } as DoctorResponse);
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to run doctor consistency check',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.get('/api/debug/supervision', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const reviews = listRecentReviews(saivageDir, 50);
      const quarantineIndex = listQuarantineIndex(saivageDir);

      const blockedCount = reviews.filter((r) => r.status === 'blocked').length;
      const passedCount = reviews.filter((r) => r.status === 'passed').length;
      const sanitizedCount = reviews.filter((r) => r.status === 'sanitized').length;

      const byRisk: Record<string, number> = {};
      for (const r of reviews) {
        byRisk[r.risk] = (byRisk[r.risk] || 0) + 1;
      }

      const bySourceKind: Record<string, number> = {};
      for (const r of reviews) {
        bySourceKind[r.source_kind] = (bySourceKind[r.source_kind] || 0) + 1;
      }

      const quarantineSummary = quarantineIndex.map((entry) => ({
        quarantine_id: entry.quarantine_id,
        review_id: entry.review_id,
        source_ref: entry.source_ref,
        risk: entry.risk,
        created_at: entry.created_at,
      }));

      return reply.send({
        reviews,
        quarantine: quarantineSummary,
        stats: {
          total: reviews.length,
          blocked: blockedCount,
          passed: passedCount,
          sanitized: sanitizedCount,
          byRisk,
          bySourceKind,
        },
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read supervision data',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });
}
