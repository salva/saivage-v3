import { EventsReadModelService } from '../../application/read-models/index.js';
import type { EventsQuery } from '../../contracts/index.js';
import type { OperatorContractHandlerMap, OperatorProjectContext } from './operator-handler-context.js';

export function buildEventsOperatorContractHandlers(options: OperatorProjectContext): OperatorContractHandlerMap {
  const readModel = new EventsReadModelService(options.projectRoot);

  return {
    'events.list': ({ query }) => {
      try {
        return { body: readModel.listEvents((query ?? {}) as EventsQuery) };
      } catch (err) {
        return {
          statusCode: 500,
          body: {
            error: 'Failed to query events',
            message: readModel.errorMessage(err),
          },
        };
      }
    },
  };
}
