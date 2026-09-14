import { buildContentPolicyReadModel, buildRuntimeStatusReadModel, CardsReadModelService } from '../../application/read-models/index.js';
import type { OperatorApiHandlerResult } from '../../contracts/index.js';
import type {
  OperatorAvailabilityContext,
  OperatorCardServiceContext,
  OperatorProjectContext,
  OperatorRuntimeProviderContext,
} from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import { SAIVAGE_VERSION } from '../../version.js';

type RuntimeCardOperatorHandlerOptions = OperatorProjectContext & OperatorRuntimeProviderContext & OperatorAvailabilityContext & OperatorCardServiceContext;

function rejectSuppliedRuntimeControlBody(body: unknown): Extract<OperatorApiHandlerResult<'runtime.pause'>, { statusCode: 400 }> | null {
  if (body === undefined) return null;
  return {
    statusCode: 400,
    body: {
      error: 'ValidationError',
      message: 'Runtime control request must not include a body',
      issues: [{ path: 'body', message: 'Request body must be absent' }],
    },
  };
}

export function buildRuntimeCardOperatorContractHandlers(options: RuntimeCardOperatorHandlerOptions) {
  const { projectRoot } = options;
  let cardsReadModel: CardsReadModelService | null = null;
  const getCardsReadModel = () => {
    cardsReadModel ??= new CardsReadModelService(projectRoot, options.cardStore, options.runtimeApplication.runtimeApi);
    return cardsReadModel;
  };

  return defineOperatorContractHandlers({
    'health.liveness': () => ({ body: { status: 'ok', version: SAIVAGE_VERSION, project: 'saivage-v3' } }),
    'health.readiness': () => {
      const serverAvailability = options.serverAvailabilityProvider();
      return { body: { status: 'ready', serverAvailability } };
    },
    'runtime.getState': () => getCardsReadModel().getRuntimeState(options.serverAvailabilityProvider()),
    'runtime.contentPolicy': () => ({ body: buildContentPolicyReadModel(projectRoot) }),
    'cards.children': ({ params }) => getCardsReadModel().getChildren(params.id),
    'cards.get': ({ params }) => getCardsReadModel().getCard(params.id),
    'cards.records.list': ({ params }) => getCardsReadModel().listRecords(params.id),
    'cards.records.get': ({ params }) => getCardsReadModel().getRecord(params.id, params.name),
    'cards.records.history.list': ({ params }) => getCardsReadModel().listRecordHistory(params.id, params.name),
    'cards.records.versions.get': ({ params }) => getCardsReadModel().getRecordVersion(params.id, params.name, params.version),
    'cards.records.diff': ({ params, query }) => getCardsReadModel().diffRecord(params.id, params.name, query),
    'cards.history.list': ({ params }) => getCardsReadModel().listHistory(params.id),
    'cards.history.get': ({ params }) => getCardsReadModel().getHistoryEntry(params.id, params.version),
    'cards.diff': ({ params, query }) => getCardsReadModel().diffCard(params.id, query),
    'runtime.status': () => {
      return { body: buildRuntimeStatusReadModel({ runtimeApi: options.runtimeApplication.runtimeApi, serverAvailability: options.serverAvailabilityProvider(), restartCapability: options.restartCapability,oversight:options.runtimeApplication.getOversightStatus() }) };
    },
    'runtime.pause': ({ request }) => {
      const rejection = rejectSuppliedRuntimeControlBody(request.body);
      if (rejection) return rejection;
      options.runtimeApplication.runtimeApi.pause();
      return { body: buildRuntimeStatusReadModel({ runtimeApi: options.runtimeApplication.runtimeApi, serverAvailability: options.serverAvailabilityProvider(), restartCapability: options.restartCapability,oversight:options.runtimeApplication.getOversightStatus() }) };
    },
    'runtime.resume': ({ request }) => {
      const rejection = rejectSuppliedRuntimeControlBody(request.body);
      if (rejection) return rejection;
      options.runtimeApplication.runtimeApi.resume();
      return { body: buildRuntimeStatusReadModel({ runtimeApi: options.runtimeApplication.runtimeApi, serverAvailability: options.serverAvailabilityProvider(), restartCapability: options.restartCapability,oversight:options.runtimeApplication.getOversightStatus() }) };
    },
    stop_project: async ({ request }) => {
      const rejection = rejectSuppliedRuntimeControlBody(request.body);
      if (rejection) return rejection;
      return { body: await options.runtimeApplication.runtimeApi.stopProject() };
    },
    restart_server: ({ reply }) => {
      if (!options.restartCapability.available) return { statusCode: 403, body: { code: 'restart_unavailable', message: 'restart unavailable: operator authentication disabled' } };
      const restartPort = options.restartCapability.port;
      restartPort.schedule();
      reply.raw.once('finish', () => { void restartPort.acknowledge(); });
      return { body: { status: 'restart_scheduled' } };
    },
  });
}
