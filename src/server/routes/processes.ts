import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { listProcesses, getProcess } from '../../utils/process-runner.js';
import type { ProcessRecord } from '../../schemas/types.js';

// ── Route Registration ────────────────────────────────────────

export function registerProcessRoutes(
  fastify: FastifyInstance,
  projectRoot: string,
): void {
  // ═══════════════════════════════════════════════════════════
  // GET /api/processes — list all processes
  // ═══════════════════════════════════════════════════════════

  fastify.get('/api/processes', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const processes: ProcessRecord[] = listProcesses(projectRoot);
      return reply.send({ processes });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to list processes',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // GET /api/processes/:id — get a single process by ID
  // ═══════════════════════════════════════════════════════════

  fastify.get('/api/processes/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      const procId = params.id;

      if (!procId) {
        return reply.status(400).send({ error: 'Process ID is required.' });
      }

      const process: ProcessRecord | null = getProcess(projectRoot, procId);

      if (!process) {
        return reply.status(404).send({
          error: 'Process not found',
          processId: procId,
        });
      }

      return reply.send({ process });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to get process',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
