import type { FastifyInstance } from 'fastify';
import { getAuthPolicy } from '../auth-policy.js';

export function registerAuthRoutes(fastify: FastifyInstance): void {
  fastify.post('/api/auth/ws-ticket', async (_request, reply) => {
    const ticket = getAuthPolicy().issueWebSocketTicket();
    return reply.send(ticket);
  });
}
