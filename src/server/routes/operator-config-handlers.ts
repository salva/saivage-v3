import type { ControlActionsQuery } from '../../contracts/index.js';
import type { ProviderRoutingReadModel } from '../../agents/provider-routing-read-model.js';
import { listControlActions } from '../../persistence/index.js';
import { redactForOutbound } from '../../redaction/index.js';
import type { OperatorConfigContext, OperatorContractHandlerMap, OperatorProjectContext } from './operator-handler-context.js';

const CONFIG_UNAVAILABLE_MESSAGE = 'Server was not started with a validated Environment config.';

function redactControlAction<T>(value: T): T {
  return redactForOutbound(value, 'operator.api', { source: 'runtime-config-notes.route' }) as T;
}

function configProviderProjection(config: unknown): ProviderRoutingReadModel | null {
  const providers = (config as { providers?: Record<string, unknown> } | null)?.providers;
  if (!providers) return null;
  return {
    providers: Object.fromEntries(Object.entries(providers).map(([name, raw]) => {
      const provider = raw as { priority?: unknown; models?: unknown; baseUrl?: unknown; accounts?: unknown };
      const models = Array.isArray(provider.models) ? provider.models.filter((model): model is string => typeof model === 'string') : [];
      const accounts = provider.accounts && typeof provider.accounts === 'object' ? Object.keys(provider.accounts) : [];
      const candidates = accounts.length > 0 ? accounts.flatMap((account) => models.map((model) => `${name}/${account}/${model}`)) : models.map((model) => `${name}/_/${model}`);
      return [name, {
        priority: typeof provider.priority === 'number' ? provider.priority : 0,
        models,
        ...(typeof provider.baseUrl === 'string' ? { baseUrl: provider.baseUrl } : {}),
        accounts,
        candidateCount: candidates.length,
        availableCandidateCount: candidates.length,
        capabilitiesByModel: Object.fromEntries(models.map((model) => [model, {}])),
        availability: Object.fromEntries(candidates.map((candidate) => [candidate, { state: 'HEALTHY' }])),
      }];
    })),
  };
}

export function buildConfigOperatorContractHandlers(options: OperatorProjectContext & OperatorConfigContext): OperatorContractHandlerMap {
  return {
    'config.get': () => {
      try {
        const effective = options.configAuthority.loadEffective();
        const config = redactForOutbound(effective.config, 'operator.api', { source: 'runtime-config-notes.config' });
        return { body: { config, warnings: [...effective.warnings] } };
      } catch (error) {
        return {
          statusCode: 500,
          body: { error: 'Configuration unavailable', message: error instanceof Error ? error.message : CONFIG_UNAVAILABLE_MESSAGE },
        };
      }
    },
    'providers.list': () => {
      let readModel = options.providerRoutingReadModelProvider?.();
      if (!readModel) {
        try { readModel = configProviderProjection(options.configAuthority.loadEffective().config) ?? undefined; }
        catch { readModel = undefined; }
      }
      if (!readModel) {
        return {
          statusCode: 500,
          body: { error: 'Providers unavailable', message: CONFIG_UNAVAILABLE_MESSAGE },
        };
      }
      return { body: readModel };
    },
    'controlActions.list': ({ query }) => {
      try {
        const filters = (query ?? {}) as ControlActionsQuery;
        const actions = listControlActions(options.projectRoot, { card_id: filters.card_id, since: filters.since }).map((entry) => redactControlAction(entry));
        return { body: { control_actions: actions, total: actions.length } };
      } catch (err) {
        return {
          statusCode: 500,
          body: {
            error: 'Failed to list control actions',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  };
}
