import { readdirSync, statSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readRuntimeState } from '../../utils/runtime-state.js';
import { readFreezeManifest } from '../../utils/freeze-manifest.js';
import { CardStore } from '../../utils/card-store.js';
import { getSafeFileForAgent } from '../../utils/file-access-security.js';
import { AnalystHandler } from '../../agents/analyst-handler.js';

// ── Constants ─────────────────────────────────────────────────

const MAX_FILE_SIZE_BYTES = 1_048_576; // 1 MB

/** Safe pattern for session IDs: alphanumeric with hyphens and underscores. */
const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

// ── Analyst handler lazy singleton ─────────────────────────────

let _analystHandler: AnalystHandler | null = null;
function getAnalystHandler(projectRoot: string): AnalystHandler {
  if (!_analystHandler) {
    _analystHandler = new AnalystHandler(projectRoot);
  }
  return _analystHandler;
}

// ── Helpers ───────────────────────────────────────────────────

function resolveSafe(
  projectRoot: string,
  requestedPath: string,
): { safe: boolean; absolutePath: string; reason?: string } {
  if (!requestedPath) {
    return { safe: false, absolutePath: '', reason: 'Path is required.' };
  }

  if (requestedPath.includes('..')) {
    return {
      safe: false,
      absolutePath: '',
      reason: 'Path traversal detected. Use of ".." is not allowed.',
    };
  }

  const resolvedRoot = resolve(projectRoot);
  const normalized = requestedPath.startsWith('/') ? requestedPath : join(projectRoot, requestedPath);
  const resolved = resolve(normalized);

  if (!resolved.startsWith(resolvedRoot + '/') && resolved !== resolvedRoot) {
    return {
      safe: false,
      absolutePath: '',
      reason: 'Path is outside the project root.',
    };
  }

  // If the path exists on disk, resolve symlinks for true containment check.
  // If it doesn't exist yet, we trust the naive containment check — the caller
  // will handle the "not found" case with the appropriate status code.
  if (existsSync(resolved)) {
    try {
      const realPath = realpathSync(resolved);
      const realRoot = realpathSync(resolvedRoot);
      if (!realPath.startsWith(realRoot + '/') && realPath !== realRoot) {
        return {
          safe: false,
          absolutePath: '',
          reason: 'Symlink target is outside the project root.',
        };
      }
      return { safe: true, absolutePath: realPath };
    } catch {
      return {
        safe: false,
        absolutePath: '',
        reason: 'Path cannot be resolved.',
      };
    }
  }

  return { safe: true, absolutePath: resolved };
}

// ── Route Registration ────────────────────────────────────────

export function registerChatsFilesDebugRoutes(
  fastify: FastifyInstance,
  projectRoot: string,
): void {
  const store = new CardStore(projectRoot);

  // ═══════════════════════════════════════════════════════════
  // Chat endpoints
  // ═══════════════════════════════════════════════════════════

  fastify.get('/api/chats', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const sessionsDir = join(projectRoot, '.saivage', 'agents', 'sessions');
      const sessions: Array<{ id: string; role: string; status: string; started_at: string }> = [];

      if (existsSync(sessionsDir)) {
        const files = readdirSync(sessionsDir).filter((f: string) => f.endsWith('.json'));
        for (const file of files) {
          try {
            const data = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'));
            sessions.push({
              id: data.id || file.replace('.json', ''),
              role: data.role || 'analyst',
              status: data.status || 'done',
              started_at: data.started_at || '',
            });
          } catch {
            // Skip unparseable files
          }
        }
      }

      return reply.send({ sessions });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to list chat sessions',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.get('/api/chats/:sessionId', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { sessionId: string };
      const sessionId = params.sessionId;

      // Validate sessionId against safe pattern to prevent path traversal
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
              // Skip
            }
          }
        }
      }

      return reply.send({ sessionId, messages });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read session messages',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.post('/api/chats/:sessionId', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { sessionId: string };
      const sessionId = params.sessionId;
      const body = request.body as { content?: string };

      // Validate sessionId against safe pattern
      if (!SAFE_SESSION_ID_RE.test(sessionId)) {
        return reply.status(400).send({ error: 'Invalid session ID format.', sessionId });
      }

      if (!body.content) {
        return reply.status(400).send({ error: 'Message content is required' });
      }

      // Route through analyst handler
      const handler = getAnalystHandler(projectRoot);
      const response = await handler.handleMessage(sessionId, body.content);

      return reply.send({
        sessionId: response.sessionId,
        message: response.message,
        toolInvocations: response.toolInvocations ?? [],
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to process chat message',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Files endpoints
  // ═══════════════════════════════════════════════════════════

  fastify.get('/api/files', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as { path?: string };
      const requestedPath = query.path || '.';

      const { safe, absolutePath, reason } = resolveSafe(projectRoot, requestedPath);
      if (!safe) {
        return reply.status(403).send({ error: reason });
      }

      if (!existsSync(absolutePath)) {
        return reply.status(404).send({ error: 'Path not found', path: requestedPath });
      }

      const pathStat = statSync(absolutePath);
      if (!pathStat.isDirectory()) {
        return reply.status(400).send({ error: 'Path is not a directory', path: requestedPath });
      }

      const entries = readdirSync(absolutePath);
      const files = entries.map((entry: string) => {
        const entryPath = join(absolutePath, entry);
        const entryStat = statSync(entryPath);
        const relPath = relative(projectRoot, entryPath);
        return {
          name: entry,
          path: relPath,
          type: entryStat.isDirectory() ? 'directory' : 'file',
          size: entryStat.isFile() ? entryStat.size : undefined,
          modifiedAt: entryStat.mtime.toISOString(),
        };
      });

      return reply.send({ path: requestedPath, files });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to list directory',
        message: err instanceof Error ? err.message : String(err),
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

      const { safe, absolutePath, reason } = resolveSafe(projectRoot, requestedPath);
      if (!safe) {
        return reply.status(403).send({ error: reason });
      }

      if (!existsSync(absolutePath)) {
        return reply.status(404).send({ error: 'File not found', path: requestedPath });
      }

      const fileStat = statSync(absolutePath);
      if (fileStat.isDirectory()) {
        return reply.status(400).send({ error: 'Path is a directory', path: requestedPath });
      }

      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        return reply.status(413).send({
          error: `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes.`,
          path: requestedPath,
          size: fileStat.size,
          maxSize: MAX_FILE_SIZE_BYTES,
        });
      }

      const rawContent = readFileSync(absolutePath, 'utf-8');

      // Apply file-access-security: blocks read-blocked files (auth-profiles.json)
      // and redacts secrets in sensitive files (saivage.json).
      const relPath = relative(projectRoot, absolutePath);
      const safeResult = getSafeFileForAgent(relPath, rawContent);

      if (safeResult.blocked) {
        return reply.status(403).send({
          error: safeResult.reason || 'Access to this file is blocked for security reasons.',
          path: requestedPath,
        });
      }

      return reply.send({
        path: requestedPath,
        size: fileStat.size,
        contentType: 'text/plain',
        content: safeResult.safeContent,
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read file',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Debug endpoints
  // ═══════════════════════════════════════════════════════════

  fastify.get('/api/debug/state', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const state = readRuntimeState(projectRoot);

      // If runtime is frozen, inject the freeze reason from the manifest
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

      // NOTE: Debug state intentionally does NOT include raw config
      // (saivage.json), which may contain secrets. The runtime state and
      // card index are metadata-only and safe to expose.

      return reply.send({
        runtime: state,
        cards: cardIndex,
        totalCards: cards.length,
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to dump debug state',
        message: err instanceof Error ? err.message : String(err),
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
            // skip
          }
        }
      }

      return reply.send({ errors, total: errors.length });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read errors',
        message: err instanceof Error ? err.message : String(err),
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
            // skip
          }
        }
      }

      return reply.send({ events, total: events.length });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read timeline',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
