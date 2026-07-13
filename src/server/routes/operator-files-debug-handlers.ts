import { DebugReadModelService, WorkspaceFileReadModelService } from '../../application/read-models/index.js';
import type { CardStore } from '../../cards/store-api.js';
import type { OperatorContractHandlerMap, OperatorProjectContext } from './operator-handler-context.js';

export function buildFilesDebugOperatorContractHandlers(options: OperatorProjectContext & { cardStoreProvider: () => CardStore | undefined }): OperatorContractHandlerMap {
  const requireCardStore = (): CardStore => {
    const store = options.cardStoreProvider();
    if (!store) throw new Error('CardStore is unavailable. Start runtime or provide a server-owned CardStore.');
    return store;
  };
  const fileReadModel = new WorkspaceFileReadModelService(options.projectRoot, () => requireCardStore().recordReader);

  return {
    'files.list': ({ query }) => fileReadModel.listFiles((query as { path?: string } | undefined)?.path || '.'),
    'files.content': ({ query }) => fileReadModel.readFileContent((query as { path?: string } | undefined)?.path),
    'debug.state': () => ({ body: new DebugReadModelService(options.projectRoot, requireCardStore()).getState() }),
    'debug.errors': () => ({ body: new DebugReadModelService(options.projectRoot, requireCardStore()).getErrors() }),
    'debug.timeline': () => ({ body: new DebugReadModelService(options.projectRoot, requireCardStore()).getTimeline() }),
  };
}
