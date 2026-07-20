import { DebugReadModelService, WorkspaceFileReadModelService } from '../../application/read-models/index.js';
import type { CardService } from '../../cards/card-api.js';
import { defineOperatorContractHandlers, type OperatorProjectContext } from './operator-handler-context.js';

export function buildFilesDebugOperatorContractHandlers(options: OperatorProjectContext & { cardServiceProvider: () => CardService }) {
  const fileReadModel = new WorkspaceFileReadModelService(options.projectRoot, () => {
    const cards = options.cardServiceProvider();
    return { record: cards.recordReader.record, isActiveCardId: (cardId: string) => cards.read(cardId) !== null };
  });
  const debugReadModel = new DebugReadModelService(options.projectRoot);

  return defineOperatorContractHandlers({
    'files.list': ({ query }) => fileReadModel.listFiles(query.path || '.'),
    'files.content': ({ query }) => fileReadModel.readFileContent(query.path),
    'debug.errors': () => ({ body: debugReadModel.getErrors() }),
    'debug.timeline': () => ({ body: debugReadModel.getTimeline() }),
  });
}
