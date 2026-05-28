import type { ProviderEntry } from '../../agents/config-api.js';
import type { ControlActionsQuery } from '../../contracts/index.js';
import { listControlActions } from '../../persistence/index.js';
import { redactForOutbound } from '../../redaction/index.js';
import type { OperatorConfigContext, OperatorContractHandlerMap, OperatorProjectContext } from './operator-handler-context.js';

const CONFIG_UNAVAILABLE_MESSAGE = 'Server was not started with a validated Environment config.';

function redactControlAction<T>(value: T): T {
  return redactForOutbound(value, 'operator.api', { source: 'runtime-config-notes.route' }) as T;
}

export function buildConfigOperatorContractHandlers(options: OperatorProjectContext & OperatorConfigContext): OperatorContractHandlerMap {
  return {
    'config.get': () => {
      if (!options.saivageConfig) {
        return {
          statusCode: 500,
          body: { error: 'Configuration unavailable', message: CONFIG_UNAVAILABLE_MESSAGE },
        };
      }
      const config = redactForOutbound(options.saivageConfig, 'operator.api', { source: 'runtime-config-notes.config' });
      return { body: { config, warnings: [...(options.configWarnings ?? [])] } };
    },
    'providers.list': () => {
      if (!options.saivageConfig) {
        return {
          statusCode: 500,
          body: { error: 'Providers unavailable', message: CONFIG_UNAVAILABLE_MESSAGE },
        };
      }
      const providers: Record<string, unknown> = {};
      for (const [name, provider] of Object.entries(options.saivageConfig.providers)) {
        const p = provider as ProviderEntry;
        providers[name] = {
          priority: p.priority,
          models: p.models,
          baseUrl: p.baseUrl,
          hasAccounts: p.accounts ? Object.keys(p.accounts).length : 0,
          status: 'unknown',
        };
      }
      return { body: { providers } };
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
