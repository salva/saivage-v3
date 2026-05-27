import type { FastifyInstance } from 'fastify';
import type { ActiveRuntime } from '../../runtime/control-api.js';
import type { ProviderEntry, SaivageConfig } from '../../agents/config-api.js';
import { redactForOutbound } from '../../redaction/index.js';
import { listControlActions } from '../../persistence/index.js';
import { type ServerAvailability } from '../../contracts/index.js';
import { readLatestLlmExchange, LlmExchangeCorruptedError } from '../../agents/session-api.js';
import { AgentOperatorReadModelService, isSafeAgentSessionId } from '../../application/read-models/index.js';

function saivageDir(projectRoot: string): string { return `${projectRoot}/.saivage`; }
function redactValue<T>(value: T): T {
  return redactForOutbound(value, 'operator.api', { source: 'runtime-config-notes.route' }) as T;
}

export function registerRuntimeConfigNotesRoutes(fastify: FastifyInstance, projectRoot: string, activeRuntime?: ActiveRuntime, serverAvailabilityProvider?: () => ServerAvailability, saivageConfig?: SaivageConfig, configWarnings: readonly string[] = []): void {
  const agentReadModel = new AgentOperatorReadModelService(projectRoot, activeRuntime);
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
  fastify.get('/api/agents/:id', async (request, reply) => { try { const params = request.params as { id: string }; const result = agentReadModel.getSession(params.id); return reply.status(result.statusCode ?? 200).send(result.body); } catch (err) { return reply.status(500).send({ error: 'Failed to read agent session', message: err instanceof Error ? err.message : String(err) }); } });
  fastify.get('/api/agents/:id/conversation', async (request, reply) => { try { const params = request.params as { id: string }; const result = agentReadModel.getConversation(params.id); return reply.status(result.statusCode ?? 200).send(result.body); } catch (err) { return reply.status(500).send({ error: 'Failed to read agent conversation', message: err instanceof Error ? err.message : String(err) }); } });
  fastify.get('/api/agents/:id/llm-exchange', async (request, reply) => {
    const params = request.params as { id: string };
    const sessionId = params.id;
    if (!isSafeAgentSessionId(sessionId)) return reply.status(400).send({ error: 'Invalid agent session ID' });
    try {
      const exchange = await readLatestLlmExchange(saivageDir(projectRoot), sessionId);
      if (!exchange) return reply.status(404).send({ error: 'No LLM exchange recorded for this session yet.' });
      return reply.send({ exchange });
    } catch (err) {
      if (err instanceof LlmExchangeCorruptedError) {
        request.log.error({ err, sessionId, cause: err.cause }, 'Corrupted LLM exchange record');
        return reply.status(500).send({ error: 'Corrupted LLM exchange record.' });
      }
      return reply.status(500).send({ error: 'Failed to read LLM exchange', message: err instanceof Error ? err.message : String(err) });
    }
  });
}
