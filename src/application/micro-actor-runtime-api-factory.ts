import { createSupervisorRuntimeApi } from '../runtime/actors/index.js';
import type { EventBus } from '../events/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { RuntimeContextCardReader } from '../runtime/context-builder.js';
import type { ProjectRootCardReader } from '../runtime/actors/index.js';

export interface MicroActorRuntimeApiFactoryDeps {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: ProjectRootCardReader & RuntimeContextCardReader;
  now?: () => string;
}

export function createMicroActorRuntimeApi(deps: MicroActorRuntimeApiFactoryDeps): RuntimeApi {
  return createSupervisorRuntimeApi({
    projectRoot: deps.projectRoot,
    eventBus: deps.eventBus,
    rootCards: deps.cardStore,
    contextCards: deps.cardStore,
    now: deps.now,
  });
}
