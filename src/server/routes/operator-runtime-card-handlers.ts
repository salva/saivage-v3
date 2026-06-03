import {
  buildCardRunsResponse,
  buildRuntimeStatusReadModel,
  CardsReadModelService,
} from '../../application/read-models/index.js';
import type {
  OperatorAvailabilityContext,
  OperatorContractHandlerMap,
  OperatorProjectContext,
  OperatorRuntimeProviderContext,
} from './operator-handler-context.js';

type RuntimeCardOperatorHandlerOptions = OperatorProjectContext & OperatorRuntimeProviderContext & OperatorAvailabilityContext;

export function buildRuntimeCardOperatorContractHandlers(options: RuntimeCardOperatorHandlerOptions): OperatorContractHandlerMap {
  const { projectRoot } = options;
  const cardsReadModel = new CardsReadModelService(projectRoot);

  return {
    'health.liveness': () => ({ body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' } }),
    'health.readiness': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      return { statusCode: 200, body: { status: 'ready', ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'runtime.getState': () => cardsReadModel.getRuntimeState(options.serverAvailabilityProvider?.()),
    'cards.list': () => cardsReadModel.listCards(),
    'cards.get': ({ params }) => cardsReadModel.getCard((params as unknown as { id: string }).id),
    'cards.history.list': ({ params }) => cardsReadModel.listHistory((params as unknown as { id: string }).id),
    'cards.history.get': ({ params }) => {
      const { id, seq } = params as unknown as { id: string; seq: string };
      return cardsReadModel.getHistoryEntry(id, seq);
    },
    'cards.diff': ({ params, query }) => cardsReadModel.diffCard((params as unknown as { id: string }).id, query as unknown as { from?: string; to?: string }),
    'runtime.status': () => ({ body: buildRuntimeStatusReadModel({ projectRoot, activeRuntime: options.runtimeApplicationProvider()?.runtimeApi, serverAvailability: options.serverAvailabilityProvider?.() }) }),
    'runtime.cardRuns': () => ({ body: buildCardRunsResponse(projectRoot) }),
  };
}
