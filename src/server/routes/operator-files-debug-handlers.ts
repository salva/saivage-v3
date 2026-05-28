import { operatorApiContracts } from '../../contracts/index.js';
import { DebugReadModelService, WorkspaceFileReadModelService } from '../../application/read-models/index.js';
import type { ContractHandler } from '../contract-runtime.js';

export function buildFilesDebugOperatorContractHandlers(options: {
  projectRoot: string;
}): Partial<Record<keyof typeof operatorApiContracts, ContractHandler>> {
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
