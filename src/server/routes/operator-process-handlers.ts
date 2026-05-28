import { ProcessReadModelService } from '../../application/read-models/index.js';
import type { OperatorContractHandlerMap, OperatorProjectContext } from './operator-handler-context.js';

export function buildProcessOperatorContractHandlers(options: OperatorProjectContext): OperatorContractHandlerMap {
  const readModel = new ProcessReadModelService(options.projectRoot);

  return {
    'processes.list': () => {
      try {
        return { body: readModel.listProcesses() };
      } catch (err) {
        return {
          statusCode: 500,
          body: {
            error: 'Failed to list processes',
            message: readModel.errorMessage(err),
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
        const process = readModel.getProcess(processId);
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
            message: readModel.errorMessage(err),
          },
        };
      }
    },
  };
}
