import type { OperatorApiSuccess } from '../../contracts/index.js';
import { listControlActions } from '../../persistence/index.js';
import { redactForOutbound } from '../../redaction/index.js';
import { defineOperatorContractHandlers, type OperatorConfigContext, type OperatorProjectContext } from './operator-handler-context.js';

export function buildConfigOperatorContractHandlers(options: OperatorProjectContext & OperatorConfigContext) {
  return defineOperatorContractHandlers({
    'config.get': () => {
      const effective = options.configAuthority.loadEffective();
      const config: OperatorApiSuccess<'config.get'>['config'] = redactForOutbound(
        { ...effective.config },
      );
      return { body: { config, warnings: [...effective.warnings] } };
    },
    'providers.list': () => {
      return { body: options.providerRoutingReadModelProvider() };
    },
    'controlActions.list': ({ query }) => {
      const actions: OperatorApiSuccess<'controlActions.list'>['control_actions'] = listControlActions(
        options.projectRoot,
        { card_id: query.card_id, since: query.since },
      ).map((entry) => redactForOutbound(entry));
      return { body: { control_actions: actions, total: actions.length } };
    },
  });
}
