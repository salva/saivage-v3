import { readdirSync, statSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readRuntimeState } from '../../utils/runtime-state.js';
import { readFreezeManifest } from '../../utils/freeze-manifest.js';
import { CardStore } from '../../utils/card-store.js';
import { getSafeFileForAgent } from '../../utils/file-access-security.js';
import { AnalystHandler } from '../../agents/analyst-handler.js';
import {
  listRecentReviews,
  listQuarantineIndex,
} from '../../utils/quarantine.js';
import type {
  DoctorCheck,
  DoctorIssue,
  DoctorResponse,
} from '../../schemas/types.js';

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
  const saivageDir = join(projectRoot, '.saivage');
  const saivageWorkDir = join(projectRoot, '.saivage-work');

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

  // ═══════════════════════════════════════════════════════════
  // Doctor endpoint — card/index consistency checks
  // ═══════════════════════════════════════════════════════════

  fastify.get('/api/debug/doctor', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const indexPath = join(projectRoot, '.saivage', 'cards', 'index.json');
      const byIdDir = join(projectRoot, '.saivage', 'cards', 'by-id');
      const treeDir = join(projectRoot, '.saivage', 'cards', 'tree');

      const checks: DoctorCheck[] = [];
      const issues: DoctorIssue[] = [];

      // Load index if it exists
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
          // Can't continue with other checks without a valid index
          return reply.send({
            status: 'issues_found',
            checks,
            issues,
          } as DoctorResponse);
        }
      }

      // Discover card files on disk
      let diskCardIds: Set<string> = new Set();
      let byIdExists = false;
      if (existsSync(byIdDir)) {
        byIdExists = true;
        try {
          const files = readdirSync(byIdDir).filter((f: string) => f.endsWith('.json'));
          diskCardIds = new Set(files.map((f: string) => f.replace('.json', '')));
        } catch {
          // If we can't read the directory, treat as empty
        }
      }

      // ── Check 1: index_entries_have_card_files ──────────────

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

      // ── Check 2: card_files_have_index_entries ──────────────

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

      // ── Check 3: child_parent_consistency ────────────────────

      let childParentOk = true;
      const childParentIssues: string[] = [];

      // For every card that has children in the tree directory, verify
      // each child's parent field points back to the parent card.
      if (existsSync(treeDir)) {
        try {
          const treeFiles = readdirSync(treeDir).filter(
            (f: string) => f.endsWith('.children.json'),
          );

          for (const treeFile of treeFiles) {
            const parentId = treeFile.replace('.children.json', '');
            const treePath = join(treeDir, treeFile);

            let childIds: string[] = [];
            try {
              childIds = JSON.parse(readFileSync(treePath, 'utf-8'));
            } catch {
              childParentOk = false;
              childParentIssues.push(
                `Children file for parent '${parentId}' could not be parsed as valid JSON.`,
              );
              issues.push({
                severity: 'error',
                message: `Tree file .saivage/cards/tree/${treeFile} is not valid JSON.`,
              });
              continue;
            }

            for (const childId of childIds) {
              const childCardPath = join(byIdDir, `${childId}.json`);

              if (!existsSync(childCardPath)) {
                // Already caught by check 1 — don't double-report but note the inconsistency
                childParentOk = false;
                childParentIssues.push(
                  `Child '${childId}' listed in tree/${treeFile} has no card file.`,
                );
                issues.push({
                  severity: 'error',
                  message: `Orphaned child reference: '${childId}' is listed as child of '${parentId}' in tree/${treeFile} but no card file exists for '${childId}'.`,
                });
                continue;
              }

              try {
                const childCard = JSON.parse(readFileSync(childCardPath, 'utf-8'));
                if (childCard.parent !== parentId) {
                  childParentOk = false;
                  childParentIssues.push(
                    `Child '${childId}' has parent='${childCard.parent || 'null'}' in its card file but is listed as child of '${parentId}' in tree/${treeFile}.`,
                  );
                  issues.push({
                    severity: 'error',
                    message: `Parent mismatch: card '${childId}' has parent='${childCard.parent || 'null'}' but is listed as child of '${parentId}' in ${treeFile}.`,
                  });
                }
              } catch {
                childParentOk = false;
                childParentIssues.push(
                  `Child card file for '${childId}' could not be parsed.`,
                );
                issues.push({
                  severity: 'error',
                  message: `Child card file .saivage/cards/by-id/${childId}.json is not valid JSON.`,
                });
              }
            }
          }

          // Also check: for every card that has a parent in its card file,
          // verify that it appears in the parent's children list
          for (const id of Object.keys(indexCards)) {
            const cardFilePath = join(byIdDir, `${id}.json`);
            if (!existsSync(cardFilePath)) continue;

            try {
              const card = JSON.parse(readFileSync(cardFilePath, 'utf-8'));
              if (card.parent !== null && card.parent !== undefined) {
                const parentTreeFile = join(treeDir, `${card.parent}.children.json`);
                if (existsSync(parentTreeFile)) {
                  try {
                    const siblings = JSON.parse(readFileSync(parentTreeFile, 'utf-8'));
                    if (!Array.isArray(siblings) || !siblings.includes(id)) {
                      childParentOk = false;
                      childParentIssues.push(
                        `Card '${id}' has parent='${card.parent}' but is not listed in tree/${card.parent}.children.json.`,
                      );
                      issues.push({
                        severity: 'error',
                        message: `Child missing from parent's children list: card '${id}' has parent='${card.parent}' but is not listed in ${card.parent}.children.json.`,
                      });
                    }
                  } catch {
                    // Already reported above
                  }
                }
                // If parent tree file doesn't exist, that's a problem too
                // but the card might have been created without write to tree
                // (this is an index integrity issue, not always an error)
              }
            } catch {
              // Already caught
            }
          }
        } catch {
          childParentOk = false;
          checks.push({
            name: 'child_parent_consistency',
            passed: false,
            details: 'Could not read tree directory.',
          });
          issues.push({
            severity: 'error',
            message: 'Failed to read tree directory for child-parent consistency check.',
          });
        }
      }

      if (childParentIssues.length === 0 && !checks.some((c) => c.name === 'child_parent_consistency')) {
        checks.push({
          name: 'child_parent_consistency',
          passed: true,
          details: existsSync(treeDir)
            ? 'All child-parent relationships are consistent.'
            : 'No tree directory exists — no child-parent relationships to check.',
        });
      } else if (childParentIssues.length > 0) {
        checks.push({
          name: 'child_parent_consistency',
          passed: false,
          details: childParentIssues.join('; '),
        });
      }

      // ── Check 4: no_duplicate_ids ────────────────────────────

      // Index is a Record<string, ...> so JSON parse guarantees no duplicate keys.
      // But check the by-id/ directory for duplicate .json filenames (accounting
      // for case-sensitivity issues on different filesystems).
      let duplicateOk = true;
      const duplicateIds: string[] = [];

      if (byIdExists) {
        try {
          const files = readdirSync(byIdDir).filter((f: string) => f.endsWith('.json'));
          const lowerMap = new Map<string, string[]>();

          for (const file of files) {
            const lower = file.toLowerCase();
            if (!lowerMap.has(lower)) {
              lowerMap.set(lower, []);
            }
            lowerMap.get(lower)!.push(file);
          }

          for (const [, names] of lowerMap) {
            if (names.length > 1) {
              duplicateOk = false;
              const ids = names.map((n: string) => n.replace('.json', ''));
              duplicateIds.push(`Case-conflicting files: ${names.join(', ')}`);
              for (const id of ids) {
                issues.push({
                  severity: 'error',
                  message: `Duplicate card ID (case-insensitive): '${id}' conflicts with other IDs in by-id/ directory.`,
                });
              }
            }
          }
        } catch {
          duplicateOk = false;
          issues.push({
            severity: 'error',
            message: 'Failed to scan by-id/ directory for duplicate IDs.',
          });
        }
      }

      if (duplicateOk) {
        checks.push({
          name: 'no_duplicate_ids',
          passed: true,
          details: byIdExists
            ? `No duplicate IDs found across ${diskCardIds.size} card file(s).`
            : 'No by-id/ directory exists — no duplicate check needed.',
        });
      } else {
        checks.push({
          name: 'no_duplicate_ids',
          passed: false,
          details: duplicateIds.join('; '),
        });
      }

      // ── Determine overall status ─────────────────────────────

      const allPassed = checks.every((c) => c.passed);

      return reply.send({
        status: allPassed ? 'ok' : 'issues_found',
        checks,
        issues,
      } as DoctorResponse);
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to run doctor consistency check',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Supervision endpoint — content supervision & quarantine
  // ═══════════════════════════════════════════════════════════

  fastify.get('/api/debug/supervision', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Read recent content reviews and quarantine index safely.
      // These utilities read from .saivage/supervision/ and return
      // typed, validated data — no raw path exposure.
      const reviews = listRecentReviews(saivageDir, 50);
      const quarantineIndex = listQuarantineIndex(saivageDir);

      // Aggregate statistics for the UI summary
      const blockedCount = reviews.filter((r) => r.status === 'blocked').length;
      const passedCount = reviews.filter((r) => r.status === 'passed').length;
      const sanitizedCount = reviews.filter((r) => r.status === 'sanitized').length;

      // Risk breakdown
      const byRisk: Record<string, number> = {};
      for (const r of reviews) {
        byRisk[r.risk] = (byRisk[r.risk] || 0) + 1;
      }

      // Source kind breakdown
      const bySourceKind: Record<string, number> = {};
      for (const r of reviews) {
        bySourceKind[r.source_kind] = (bySourceKind[r.source_kind] || 0) + 1;
      }

      // Summary does NOT include stored_path from quarantine items —
      // that's an internal path. The UI uses the quarantine_id to
      // navigate via /api/files against the quarantine directory.
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
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
