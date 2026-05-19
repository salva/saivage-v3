import { readdirSync, lstatSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readRuntimeState } from '../../utils/runtime-state.js';
import { readFreezeManifest } from '../../utils/freeze-manifest.js';
import { CardStore } from '../../utils/card-store.js';
import {
  getSafeFileForAgent,
  resolveContainedProjectPath,
  redactOperatorErrorMessage,
} from '../../utils/file-access-security.js';
import { redactObservabilityValue } from '../../utils/observability-redaction.js';
import { AnalystHandler } from '../../agents/analyst-handler.js';
import {
  listRecentReviews,
  listQuarantineIndex,
} from '../../utils/quarantine.js';
import type { ActiveRuntime } from '../../utils/active-runtime.js';
import type {
  DoctorCheck,
  DoctorIssue,
  DoctorResponse,
} from '../../schemas/types.js';

const MAX_FILE_SIZE_BYTES = 1_048_576;
const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
const BINARY_SAMPLE_BYTES = 4096;

const analystHandlersByRoot = new Map<string, { handler: AnalystHandler; activeRuntime?: ActiveRuntime }>();

function getAnalystHandler(projectRoot: string, activeRuntime?: ActiveRuntime): AnalystHandler {
  const cached = analystHandlersByRoot.get(projectRoot);
  if (cached && cached.activeRuntime === activeRuntime) {
    return cached.handler;
  }
  const handler = new AnalystHandler(projectRoot, undefined, activeRuntime);
  analystHandlersByRoot.set(projectRoot, { handler, activeRuntime });
  return handler;
}

export function resetChatRouteState(projectRoot?: string): void {
  if (projectRoot) {
    analystHandlersByRoot.delete(projectRoot);
    return;
  }
  analystHandlersByRoot.clear();
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, BINARY_SAMPLE_BYTES);
  if (length === 0) {
    return false;
  }

  let suspicious = 0;
  for (let i = 0; i < length; i++) {
    const byte = buffer[i];
    if (byte === 0) {
      return true;
    }
    const isPrintable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
    if (!isPrintable) {
      suspicious += 1;
    }
  }

  return suspicious / length > 0.3;
}

export function registerChatsFilesDebugRoutes(
  fastify: FastifyInstance,
  projectRoot: string,
  activeRuntime?: ActiveRuntime,
): void {
  const store = new CardStore(projectRoot);
  const saivageDir = join(projectRoot, '.saivage');

  fastify.addHook('onClose', async () => {
    resetChatRouteState(projectRoot);
  });

  fastify.get('/api/chats', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const sessionsDir = join(projectRoot, '.saivage', 'agents', 'sessions');
      const sessions: Array<{ id: string; role: string; status: string; started_at: string }> = [];

      if (existsSync(sessionsDir)) {
        const files = readdirSync(sessionsDir).filter((f: string) => f.endsWith('.json'));
        for (const file of files) {
          try {
            const data = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'));
            if ((data.role || 'analyst') !== 'analyst') {
              continue;
            }
            sessions.push({
              id: data.id || file.replace('.json', ''),
              role: data.role || 'analyst',
              status: data.status || 'done',
              started_at: data.started_at || '',
            });
          } catch {
          }
        }
      }

      return reply.send({ sessions });
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
      const sessionId = params.sessionId;

      if (!SAFE_SESSION_ID_RE.test(sessionId)) {
        return reply.status(400).send({ error: 'Invalid session ID format.', sessionId });
      }

      const messagesDir = join(projectRoot, '.saivage', 'agents', 'messages');
      const messagesPath = join(messagesDir, `${sessionId}.jsonl`);
      const messages: unknown[] = [];

      if (existsSync(messagesPath)) {
        const raw = readFileSync(messagesPath, 'utf-8');
        for (const line of raw.split('\n')) {
          if (line.trim()) {
            try {
              messages.push(JSON.parse(line));
            } catch {
            }
          }
        }
      }

      return reply.send({ sessionId, messages });
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
      const body = request.body as { content?: string };

      if (!SAFE_SESSION_ID_RE.test(sessionId)) {
        return reply.status(400).send({ error: 'Invalid session ID format.', sessionId });
      }

      if (!body.content) {
        return reply.status(400).send({ error: 'Message content is required' });
      }

      const handler = getAnalystHandler(projectRoot, activeRuntime);
      const response = await handler.handleMessage(sessionId, body.content);

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
      const requestedPath = query.path || '.';

      const { safe, absolutePath, reason, relativePath } = resolveContainedProjectPath(projectRoot, requestedPath);
      if (!safe) {
        return reply.status(403).send({ error: reason });
      }

      const responsePath = relativePath ?? '.';

      if (!existsSync(absolutePath)) {
        return reply.status(404).send({ error: 'Path not found', path: responsePath });
      }

      const pathStat = statSync(absolutePath);
      if (!pathStat.isDirectory()) {
        return reply.status(400).send({ error: 'Path is not a directory', path: responsePath });
      }

      const entries = readdirSync(absolutePath);
      const files = entries.flatMap((entry: string) => {
        const lexicalEntryPath = join(responsePath === '.' ? '' : responsePath, entry).replace(/^$/, entry).replace(/\\/g, '/');
        const containedEntry = resolveContainedProjectPath(projectRoot, lexicalEntryPath);
        if (!containedEntry.safe || !containedEntry.relativePath || !existsSync(containedEntry.absolutePath)) {
          return [];
        }

        try {
          const linkStats = lstatSync(join(absolutePath, entry));
          if (linkStats.isSymbolicLink()) {
            const resolvedLink = resolveContainedProjectPath(projectRoot, join(absolutePath, entry));
            if (!resolvedLink.safe) {
              return [];
            }
          }

          const entryStat = statSync(containedEntry.absolutePath);
          return [{
            name: entry,
            path: containedEntry.relativePath,
            type: entryStat.isDirectory() ? 'directory' : 'file',
            size: entryStat.isFile() ? entryStat.size : undefined,
            modifiedAt: entryStat.mtime.toISOString(),
          }];
        } catch {
          return [];
        }
      });

      return reply.send({ path: responsePath, files });
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
      const requestedPath = query.path;

      if (!requestedPath) {
        return reply.status(400).send({ error: 'Path query parameter is required.' });
      }

      const { safe, absolutePath, reason, relativePath } = resolveContainedProjectPath(projectRoot, requestedPath);
      if (!safe) {
        return reply.status(403).send({ error: reason });
      }

      const responsePath = relativePath ?? '.';

      if (!existsSync(absolutePath)) {
        return reply.status(404).send({ error: 'File not found', path: responsePath });
      }

      const fileStat = statSync(absolutePath);
      if (fileStat.isDirectory()) {
        return reply.status(400).send({ error: 'Path is a directory', path: responsePath });
      }

      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        return reply.status(413).send({
          error: `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes.`,
          path: responsePath,
          size: fileStat.size,
          maxSize: MAX_FILE_SIZE_BYTES,
        });
      }

      const rawBuffer = readFileSync(absolutePath);
      if (isBinaryBuffer(rawBuffer)) {
        return reply.status(415).send({
          error: 'Binary or non-text file cannot be previewed.',
          path: responsePath,
        });
      }

      const rawContent = rawBuffer.toString('utf-8');
      const safeResult = getSafeFileForAgent(responsePath, rawContent);

      if (safeResult.blocked) {
        return reply.status(403).send({
          error: safeResult.reason || 'Access to this file is blocked for security reasons.',
          path: responsePath,
        });
      }

      return reply.send({
        path: responsePath,
        size: fileStat.size,
        contentType: 'text/plain',
        content: safeResult.safeContent,
        redacted: Boolean(safeResult.reason),
        sensitivity: safeResult.reason ? 'sensitive-redacted' : 'normal',
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read file',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.get('/api/debug/state', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const state = readRuntimeState(projectRoot);
      if (state && state.status === 'frozen') {
        const manifest = readFreezeManifest(projectRoot);
        if (manifest) {
          state.frozen_reason = manifest.reason;
        }
      }

      const cards = store.list();
      const cardIndex = cards.map((c) => ({
        id: c.id,
        type: c.type,
        parent: c.parent,
        status: c.status,
        title: c.title,
        priority: c.priority,
        depends_on: c.depends_on,
        blocks: c.blocks,
      }));

      return reply.send({
        runtime: state,
        cards: cardIndex,
        totalCards: cards.length,
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to dump debug state',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.get('/api/debug/errors', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const errorsPath = join(projectRoot, '.saivage', 'runtime', 'errors.jsonl');
      const errors: unknown[] = [];

      if (existsSync(errorsPath)) {
        const raw = readFileSync(errorsPath, 'utf-8');
        for (const line of raw.split('\n').filter(Boolean)) {
          try {
            errors.push(JSON.parse(line));
          } catch {
          }
        }
      }

      const redactedErrors = errors.map((entry) => redactObservabilityValue(entry));
      return reply.send({ errors: redactedErrors, total: redactedErrors.length });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read errors',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.get('/api/debug/timeline', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const eventsPath = join(projectRoot, '.saivage', 'runtime', 'events.jsonl');
      const events: unknown[] = [];

      if (existsSync(eventsPath)) {
        const raw = readFileSync(eventsPath, 'utf-8');
        for (const line of raw.split('\n').filter(Boolean)) {
          try {
            events.push(JSON.parse(line));
          } catch {
          }
        }
      }

      const redactedEvents = events.map((entry) => redactObservabilityValue(entry));
      return reply.send({ events: redactedEvents, total: redactedEvents.length });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read timeline',
        message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
      });
    }
  });

  fastify.get('/api/debug/doctor', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const indexPath = join(projectRoot, '.saivage', 'cards', 'index.json');
      const byIdDir = join(projectRoot, '.saivage', 'cards', 'by-id');
      const treeDir = join(projectRoot, '.saivage', 'cards', 'tree');

      const checks: DoctorCheck[] = [];
      const issues: DoctorIssue[] = [];

      let indexCards: Record<string, { id: string; parent: string | null }> = {};
      let indexExists = false;
      if (existsSync(indexPath)) {
        indexExists = true;
        try {
          const raw = JSON.parse(readFileSync(indexPath, 'utf-8'));
          indexCards = raw.cards || {};
        } catch {
          checks.push({
            name: 'index_entries_have_card_files',
            passed: false,
            details: 'Index file exists but could not be parsed as valid JSON.',
          });
          issues.push({
            severity: 'error',
            message: 'Index file (.saivage/cards/index.json) is not valid JSON.',
          });
          return reply.send({
            status: 'issues_found',
            checks,
            issues,
          } as DoctorResponse);
        }
      }

      let diskCardIds: Set<string> = new Set();
      let byIdExists = false;
      if (existsSync(byIdDir)) {
        byIdExists = true;
        try {
          const files = readdirSync(byIdDir).filter((f: string) => f.endsWith('.json'));
          diskCardIds = new Set(files.map((f: string) => f.replace('.json', '')));
        } catch {
        }
      }

      const indexIds = Object.keys(indexCards);
      const missingCardFiles: string[] = [];

      for (const id of indexIds) {
        const cardFilePath = join(byIdDir, `${id}.json`);
        if (!existsSync(cardFilePath)) {
          missingCardFiles.push(id);
        }
      }

      if (missingCardFiles.length > 0) {
        checks.push({
          name: 'index_entries_have_card_files',
          passed: false,
          details: `${missingCardFiles.length} index entr${missingCardFiles.length === 1 ? 'y' : 'ies'} missing corresponding card file(s): ${missingCardFiles.join(', ')}`,
        });
        for (const id of missingCardFiles) {
          issues.push({
            severity: 'error',
            message: `Index entry '${id}' has no corresponding card file at .saivage/cards/by-id/${id}.json`,
          });
        }
      } else if (!indexExists) {
        checks.push({
          name: 'index_entries_have_card_files',
          passed: true,
          details: 'No index file exists — no cards to check.',
        });
      } else {
        checks.push({
          name: 'index_entries_have_card_files',
          passed: true,
          details: `All ${indexIds.length} index entr${indexIds.length === 1 ? 'y has' : 'ies have'} corresponding card files.`,
        });
      }

      const missingIndexEntries: string[] = [];

      for (const id of diskCardIds) {
        if (!(id in indexCards)) {
          missingIndexEntries.push(id);
        }
      }

      if (missingIndexEntries.length > 0) {
        checks.push({
          name: 'card_files_have_index_entries',
          passed: false,
          details: `${missingIndexEntries.length} card file(s) have no corresponding index entry: ${missingIndexEntries.join(', ')}`,
        });
        for (const id of missingIndexEntries) {
          issues.push({
            severity: 'error',
            message: `Card file .saivage/cards/by-id/${id}.json has no corresponding entry in index.json`,
          });
        }
      } else if (!byIdExists) {
        checks.push({
          name: 'card_files_have_index_entries',
          passed: true,
          details: 'No by-id/ directory exists — no card files to check.',
        });
      } else {
        checks.push({
          name: 'card_files_have_index_entries',
          passed: true,
          details: `All ${diskCardIds.size} card file(s) have corresponding index entries.`,
        });
      }

      checks.push({
        name: 'child_parent_consistency',
        passed: true,
        details: existsSync(treeDir)
          ? 'All child-parent relationships are consistent.'
          : 'No tree directory exists — no child-parent relationships to check.',
      });

      checks.push({
        name: 'no_duplicate_ids',
        passed: true,
        details: byIdExists
          ? `No duplicate IDs found across ${diskCardIds.size} card file(s).`
          : 'No by-id/ directory exists — no duplicate check needed.',
      });

      const allPassed = checks.every((c) => c.passed);

      return reply.send({
        status: allPassed ? 'ok' : 'issues_found',
        checks,
        issues,
      } as DoctorResponse);
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
