import type { operatorApiContracts } from '../../contracts/index.js';
import {
  buildCardRunsResponse,
  buildRuntimeStatusReadModel,
  CardsReadModelService,
} from '../../application/read-models/index.js';
import { buildServerAvailability } from '../availability.js';
import type { ContractHandler } from '../contract-runtime.js';
import type { ActiveRuntime } from '../../runtime/control-api.js';

export function buildRuntimeCardOperatorContractHandlers(options: {
  projectRoot: string;
  activeRuntimeProvider: () => ActiveRuntime | undefined;
  serverAvailabilityProvider?: () => ReturnType<typeof buildServerAvailability>;
}): Partial<Record<keyof typeof operatorApiContracts, ContractHandler>> {
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
    'runtime.status': () => ({ body: buildRuntimeStatusReadModel({ projectRoot, activeRuntime: options.activeRuntimeProvider(), serverAvailability: options.serverAvailabilityProvider?.() }) }),
    'runtime.cardRuns': () => ({ body: buildCardRunsResponse(projectRoot) }),
  };
}
