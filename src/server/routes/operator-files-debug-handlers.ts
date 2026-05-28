import { DebugReadModelService, WorkspaceFileReadModelService } from '../../application/read-models/index.js';
import type { OperatorContractHandlerMap, OperatorProjectContext } from './operator-handler-context.js';

export function buildFilesDebugOperatorContractHandlers(options: OperatorProjectContext): OperatorContractHandlerMap {
  const fileReadModel = new WorkspaceFileReadModelService(options.projectRoot);
  const debugReadModel = new DebugReadModelService(options.projectRoot);

  return {
    'files.list': ({ query }) => fileReadModel.listFiles((query as { path?: string } | undefined)?.path || '.'),
    'files.content': ({ query }) => fileReadModel.readFileContent((query as { path?: string } | undefined)?.path),
    'debug.state': () => ({ body: debugReadModel.getState() }),
    'debug.errors': () => ({ body: debugReadModel.getErrors() }),
    'debug.timeline': () => ({ body: debugReadModel.getTimeline() }),
  };
}
