import { DebugReadModelService, WorkspaceFileReadModelService } from '../../application/read-models/index.js';
import type { CardStoreRepository } from '../../cards/store-api.js';
import type { OperatorContractHandlerMap, OperatorProjectContext } from './operator-handler-context.js';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import { projectPersistenceHealthSnapshot } from '../availability.js';

export function buildFilesDebugOperatorContractHandlers(options: OperatorProjectContext & { cardStoreProvider: () => CardStoreRepository | undefined; runtimeApplication?: RuntimeApplication }): OperatorContractHandlerMap {
  const requireCardStore = (): CardStoreRepository => {
    const store = options.cardStoreProvider();
    if (!store) throw new Error('CardStore is unavailable. Start runtime or provide a server-owned CardStore.');
    return store;
  };
  const fileReadModel = new WorkspaceFileReadModelService(options.projectRoot, () => requireCardStore().recordReader);

  return {
    'files.list': ({ query }) => fileReadModel.listFiles((query as { path?: string } | undefined)?.path || '.'),
    'files.content': ({ query }) => fileReadModel.readFileContent((query as { path?: string } | undefined)?.path),
    'debug.state': () => ({ body: new DebugReadModelService(options.projectRoot, requireCardStore(), () => options.runtimeApplication ? projectPersistenceHealthSnapshot(options.runtimeApplication.persistenceHealth.snapshot(), options.projectRoot) : ({ state: 'healthy' })).getState() }),
    'debug.errors': () => ({ body: new DebugReadModelService(options.projectRoot, requireCardStore()).getErrors() }),
    'debug.timeline': () => ({ body: new DebugReadModelService(options.projectRoot, requireCardStore()).getTimeline() }),
  };
}
