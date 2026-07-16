import { DebugReadModelService, WorkspaceFileReadModelService } from '../../application/read-models/index.js';
import type { CardService } from '../../cards/card-api.js';
import type { OperatorContractHandlerMap, OperatorProjectContext } from './operator-handler-context.js';

export function buildFilesDebugOperatorContractHandlers(options: OperatorProjectContext & { cardServiceProvider: () => CardService | undefined }): OperatorContractHandlerMap {
  const requireCardService = (): CardService => {
    const service = options.cardServiceProvider();
    if (!service) throw new Error('Card service is unavailable. Start runtime or provide a server-owned card service.');
    return service;
  };
  const fileReadModel = new WorkspaceFileReadModelService(options.projectRoot, () => {
    const cards = requireCardService();
    return { record: cards.recordReader.record, isActiveCardId: (cardId: string) => cards.read(cardId) !== null };
  });
  const debugReadModel = new DebugReadModelService(options.projectRoot);

  return {
    'files.list': ({ query }) => fileReadModel.listFiles((query as { path?: string } | undefined)?.path || '.'),
    'files.content': ({ query }) => fileReadModel.readFileContent((query as { path?: string } | undefined)?.path),
    'debug.errors': () => ({ body: debugReadModel.getErrors() }),
    'debug.timeline': () => ({ body: debugReadModel.getTimeline() }),
  };
}
