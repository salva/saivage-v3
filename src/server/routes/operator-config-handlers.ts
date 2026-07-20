import type { OperatorApiSuccess } from '../../contracts/index.js';
import { listControlActions } from '../../persistence/index.js';
import { redactForOutbound } from '../../redaction/index.js';
import { defineOperatorContractHandlers, type OperatorConfigContext, type OperatorProjectContext } from './operator-handler-context.js';

const CONFIG_UNAVAILABLE_MESSAGE = 'Server was not started with a validated Environment config.';

export function buildConfigOperatorContractHandlers(options: OperatorProjectContext & OperatorConfigContext) {
  return defineOperatorContractHandlers({
    'config.get': () => {
      try {
        const effective = options.configAuthority.loadEffective();
        const config: OperatorApiSuccess<'config.get'>['config'] = redactForOutbound(
          { ...effective.config },
          'operator.api',
          { source: 'runtime-config-notes.config' },
        );
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
        const actions: OperatorApiSuccess<'controlActions.list'>['control_actions'] = listControlActions(
          options.projectRoot,
          { card_id: query.card_id, since: query.since },
        ).map((entry) => redactForOutbound(entry, 'operator.api', { source: 'runtime-config-notes.route' }));
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
  });
}
