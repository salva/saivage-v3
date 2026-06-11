import { createInvocationProviderTurnPort, createSupervisorRuntimeApi, createTerminalCardStatusPort } from '../runtime/actors/index.js';
import type { EventBus } from '../events/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { InvocationTurnService, ProjectRootCardReader, TerminalCardStorePort } from '../runtime/actors/index.js';

export interface XStateRuntimeApiFactoryDeps {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: ProjectRootCardReader & TerminalCardStorePort;
  invocationService: InvocationTurnService;
  now?: () => string;
}

export function createXStateRuntimeApi(deps: XStateRuntimeApiFactoryDeps): RuntimeApi {
  const providerTurn = createInvocationProviderTurnPort(deps.invocationService);
  return createSupervisorRuntimeApi({
    projectRoot: deps.projectRoot,
    eventBus: deps.eventBus,
    rootCards: deps.cardStore,
    providerTurn,
    reviewerProviderTurn: providerTurn,
    terminalStatusPort: createTerminalCardStatusPort(deps.cardStore, deps.now),
    now: deps.now,
  });
}
