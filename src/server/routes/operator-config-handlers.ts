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
      return { body: options.providerRoutingReadModelProvider() };
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
