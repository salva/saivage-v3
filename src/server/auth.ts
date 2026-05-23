/**
 * Auth plugin for Fastify.
 *
 * Authenticates /api/* routes using the SAIVAGE_API_TOKEN environment variable.
 * Accepted API bearer transport:
 *   - Authorization: Bearer <token> header
 *
 * URL/query API bearer credentials are explicitly rejected when token auth is enabled.
 * WebSocket clients authenticate through short-lived tickets issued by /api/auth/ws-ticket.
 *
 * Public endpoints:
 *   - /health — no authentication required
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { getAuthPolicy } from './auth-policy.js';

// ── Auth Handler ──────────────────────────────────────────────

export async function authenticate(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const result = getAuthPolicy().validateHttpRequest(request);
  if (result.ok) return;

  // External errors are intentionally generic and never echo submitted credentials.
  throw { statusCode: result.statusCode, message: 'Unauthorized' };
}

// ── Fastify Plugin ────────────────────────────────────────────

export interface AuthPluginOptions {
  excludeRoutes?: string[];
}

const DEFAULT_EXCLUDED = ['/health', '/health/ready'];

async function authPlugin(
  fastify: FastifyInstance,
  options?: AuthPluginOptions,
): Promise<void> {
  const opts = options ?? {};
  const excluded = new Set(opts.excludeRoutes ?? DEFAULT_EXCLUDED);

  fastify.addHook('onRoute', (routeOptions) => {
    const url = routeOptions.url;

    if (excluded.has(url)) {
      return;
    }

    if (!url.startsWith('/api')) {
      return;
    }

    const existingPreHandler = routeOptions.preHandler;

    routeOptions.preHandler = async (request, reply, done) => {
      try {
        await authenticate(request, reply);
      } catch (err) {
        const e = err as { statusCode?: number; message?: string };
        // Don't call done() — send response directly
        reply.status(e.statusCode ?? 401).send({
          error: e.message ?? 'Unauthorized',
          statusCode: e.statusCode ?? 401,
        });
        return;
      }

      if (existingPreHandler) {
        if (Array.isArray(existingPreHandler)) {
          for (const handler of existingPreHandler) {
            await handler.call(fastify, request, reply, done);
          }
        } else {
          await existingPreHandler.call(fastify, request, reply, done);
        }
      }
    };
  });
}

// Export as fastify plugin
const authPluginWithMeta = fp(authPlugin, {
  name: 'saivage-auth',
});

export default authPluginWithMeta;
