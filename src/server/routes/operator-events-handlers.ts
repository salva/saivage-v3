import { EventQueryService } from '../../application/index.js';
import { defineOperatorContractHandlers, type OperatorProjectContext } from './operator-handler-context.js';

export function buildEventsOperatorContractHandlers(options: OperatorProjectContext) {
  const readModel = new EventQueryService(options.projectRoot);

  return defineOperatorContractHandlers({
    'events.list': ({ query }) => ({ body: readModel.queryEvents(query) }),
    'debug.errors': () => ({ body: readModel.queryErrors() }),
  });
}
