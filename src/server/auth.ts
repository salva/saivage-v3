/**
 * Auth plugin for Fastify.
 *
 * Authenticates /api/* and /ws routes using the SAIVAGE_API_TOKEN
 * environment variable. Accepted delivery methods:
 *   - Authorization: Bearer <token> header
 *   - ?token=<token> query parameter
 *
 * Public endpoints:
 *   - /health — no authentication required
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

// ── Constants ─────────────────────────────────────────────────

function getApiToken(): string | undefined {
  return process.env['SAIVAGE_API_TOKEN'];
}

// ── Auth Handler ──────────────────────────────────────────────

export async function authenticate(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const token = getApiToken();

  // If no token is configured, authentication is disabled
  if (!token) {
    return;
  }

  // Check Authorization: Bearer <token>
  const authHeader = request.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      if (parts[1] === token) {
        return;
      }
    }
  }

  // Check ?token= query parameter
  const queryToken = (request.query as Record<string, string> | undefined)?.['token'];
  if (queryToken === token) {
    return;
  }

  // No valid auth found
  throw { statusCode: 401, message: 'Unauthorized' };
}

// ── Fastify Plugin ────────────────────────────────────────────

export interface AuthPluginOptions {
  excludeRoutes?: string[];
}

const DEFAULT_EXCLUDED = ['/health'];

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
