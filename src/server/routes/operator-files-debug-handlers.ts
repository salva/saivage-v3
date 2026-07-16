import { DebugReadModelService, WorkspaceFileReadModelService } from '../../application/read-models/index.js';
import type { CardService } from '../../cards/card-api.js';
import type { OperatorContractHandlerMap, OperatorProjectContext } from './operator-handler-context.js';
import type { RuntimeApplication } from '../../application/runtime-composition.js';

export function buildFilesDebugOperatorContractHandlers(options: OperatorProjectContext & { cardServiceProvider: () => CardService | undefined; runtimeApplication?: RuntimeApplication }): OperatorContractHandlerMap {
  const requireCardService = (): CardService => {
    const service = options.cardServiceProvider();
    if (!service) throw new Error('Card service is unavailable. Start runtime or provide a server-owned card service.');
    return service;
  };
  const fileReadModel = new WorkspaceFileReadModelService(options.projectRoot, () => {
    const cards = requireCardService();
    return { record: cards.recordReader.record, isActiveCardId: (cardId: string) => cards.read(cardId) !== null };
  });

  return {
    'files.list': ({ query }) => fileReadModel.listFiles((query as { path?: string } | undefined)?.path || '.'),
    'files.content': ({ query }) => fileReadModel.readFileContent((query as { path?: string } | undefined)?.path),
    'debug.state': () => { if (!options.runtimeApplication) throw new Error('Runtime application is required for debug state.'); return { body: new DebugReadModelService(options.projectRoot, requireCardService(), options.runtimeApplication.runtimeApi).getState() }; },
    'debug.errors': () => ({ body: new DebugReadModelService(options.projectRoot, requireCardService(), options.runtimeApplication!.runtimeApi).getErrors() }),
    'debug.timeline': () => ({ body: new DebugReadModelService(options.projectRoot, requireCardService(), options.runtimeApplication!.runtimeApi).getTimeline() }),
  };
}
