import type { FastifyInstance } from 'fastify';
import type { ProviderEntry, SaivageConfig } from '../../agents/config-api.js';
import { redactForOutbound } from '../../redaction/index.js';
import { listControlActions } from '../../persistence/index.js';
import { type ServerAvailability } from '../../contracts/index.js';

function redactValue<T>(value: T): T {
  return redactForOutbound(value, 'operator.api', { source: 'runtime-config-notes.route' }) as T;
}

export function registerRuntimeConfigNotesRoutes(fastify: FastifyInstance, projectRoot: string, _activeRuntime?: unknown, serverAvailabilityProvider?: () => ServerAvailability, saivageConfig?: SaivageConfig, configWarnings: readonly string[] = []): void {
  fastify.get('/api/control-actions', async (request, reply) => {
    try {
      const query = request.query as { card_id?: string; since?: string };
      const actions = listControlActions(projectRoot, { card_id: query.card_id, since: query.since }).map((entry) => redactValue(entry));
      return reply.send({ control_actions: actions, total: actions.length });
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to list control actions', message: err instanceof Error ? err.message : String(err) });
    }
  });
  fastify.get('/api/config', async (_request, reply) => { if (!saivageConfig) return reply.status(500).send({ error: 'Configuration unavailable', message: 'Server was not started with a validated Environment config.' }); const config = redactForOutbound(saivageConfig, 'operator.api', { source: 'runtime-config-notes.config' }); return reply.send({ config, warnings: configWarnings }); });
  fastify.get('/api/providers', async (_request, reply) => { if (!saivageConfig) return reply.status(500).send({ error: 'Providers unavailable', message: 'Server was not started with a validated Environment config.' }); const providers: Record<string, unknown> = {}; for (const [name, provider] of Object.entries(saivageConfig.providers)) { const p = provider as ProviderEntry; providers[name] = { priority: p.priority, models: p.models, baseUrl: p.baseUrl, hasAccounts: p.accounts ? Object.keys(p.accounts).length : 0, status: 'unknown' }; } return reply.send({ providers }); });
}
