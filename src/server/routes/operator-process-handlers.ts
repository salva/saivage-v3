import { processApi } from '../../runtime/process-api.js';
import type { OperatorContractHandlerMap, OperatorProjectContext } from './operator-handler-context.js';

export function buildProcessOperatorContractHandlers(options: OperatorProjectContext): OperatorContractHandlerMap {
  const processes = processApi(options.projectRoot);

  return {
    'processes.list': () => {
      try {
        return { body: processes.listForOperator() };
      } catch (err) {
        return {
          statusCode: 500,
          body: {
            error: 'Failed to list processes',
            message: processes.errorMessage(err),
          },
        };
      }
    },
    'processes.get': ({ params }) => {
      const processId = (params as { id?: string } | undefined)?.id;
      if (!processId) {
        return { statusCode: 400, body: { error: 'Process ID is required.' } };
      }

      try {
        const process = processes.getForOperator(processId);
        if (!process) {
          return {
            statusCode: 404,
            body: {
              error: 'Process not found',
              processId,
            },
          };
        }

        return { body: process };
      } catch (err) {
        return {
          statusCode: 500,
          body: {
            error: 'Failed to get process',
            message: processes.errorMessage(err),
          },
        };
      }
    },
  };
}
