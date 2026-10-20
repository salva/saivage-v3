import type { OperatorApiSuccess } from '../../contracts/index.js';
import { listControlActions } from '../../persistence/index.js';
import { projectEffectiveConfigForOutbound } from '../../config/index.js';
import { redactTextForOutbound } from '../../redaction/index.js';
import { EventQueryService } from '../../application/index.js';
import {
  defineOperatorContractHandlers,
  type OperatorConfigContext,
  type OperatorProjectContext,
} from './operator-handler-context.js';

export function buildConfigOperatorContractHandlers(
  options: OperatorProjectContext & OperatorConfigContext,
) {
  return defineOperatorContractHandlers({
    'externalToolCalls.list': () => {
      const calls = new EventQueryService(options.projectRoot).queryExternalToolCalls();
      return { body: { external_tool_calls: calls, total: calls.length } };
    },
    'config.get': () => {
      const effective = options.configAuthority.loadEffective();
      const config: OperatorApiSuccess<'config.get'>['config'] = projectEffectiveConfigForOutbound(
        effective.config,
      );
      return { body: { config, warnings: effective.warnings.map(redactTextForOutbound) } };
    },
    'providers.list': () => {
      return { body: options.providerRoutingReadModelProvider() };
    },
    'controlActions.list': ({ query }) => {
      const actions: OperatorApiSuccess<'controlActions.list'>['control_actions'] =
        listControlActions(options.projectRoot, { card_id: query.card_id, since: query.since });
      return { body: { control_actions: actions, total: actions.length } };
    },
  });
}
