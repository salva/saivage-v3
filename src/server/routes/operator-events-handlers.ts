import { EventsReadModelService } from '../../application/read-models/index.js';
import { defineOperatorContractHandlers, type OperatorProjectContext } from './operator-handler-context.js';

export function buildEventsOperatorContractHandlers(options: OperatorProjectContext) {
  const readModel = new EventsReadModelService(options.projectRoot);

  return defineOperatorContractHandlers({
    'events.list': ({ query }) => ({ body: readModel.listEvents(query) }),
  });
}
