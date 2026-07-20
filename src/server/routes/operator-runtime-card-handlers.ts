import {
  buildCardRunsResponse,
  buildRuntimeStatusReadModel,
  CardsReadModelService,
} from '../../application/read-models/index.js';
import type { OperatorApiHandlerResult } from '../../contracts/index.js';
import type {
  OperatorAvailabilityContext,
  OperatorCardServiceContext,
  OperatorProjectContext,
  OperatorRuntimeProviderContext,
} from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';

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

function requireCardService(service: RuntimeCardOperatorHandlerOptions['cardStore']) {
  if (!service) throw new Error('Card service is unavailable. Use the production server composition or provide a route test service.');
  return service;
}

export function buildRuntimeCardOperatorContractHandlers(options: RuntimeCardOperatorHandlerOptions) {
  const { projectRoot } = options;
  let cardsReadModel: CardsReadModelService | null = null;
  const getCardsReadModel = () => {
    if (!options.runtimeApplication) throw new Error('Runtime application is required for runtime state.');
    cardsReadModel ??= new CardsReadModelService(projectRoot, requireCardService(options.cardStore), options.runtimeApplication.runtimeApi);
    return cardsReadModel;
  };

  return defineOperatorContractHandlers({
    'health.liveness': () => ({ body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' } }),
    'health.readiness': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      const ready = serverAvailability?.components.runtime.state !== 'unavailable';
      return { statusCode: ready ? 200 : 503, body: { status: ready ? 'ready' : 'not_ready', ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'runtime.getState': () => getCardsReadModel().getRuntimeState(options.serverAvailabilityProvider?.()),
    'cards.children': ({ params }) => getCardsReadModel().getChildren(params.id),
    'cards.get': ({ params }) => getCardsReadModel().getCard(params.id),
    'cards.history.list': ({ params }) => getCardsReadModel().listHistory(params.id),
    'cards.history.get': ({ params }) => getCardsReadModel().getHistoryEntry(params.id, params.seq),
    'cards.diff': ({ params, query }) => getCardsReadModel().diffCard(params.id, query),
    'runtime.status': () => {
      if (!options.runtimeApplication) throw new Error('Runtime application is required for runtime status.');
      return { body: { ...buildRuntimeStatusReadModel({ runtimeApi: options.runtimeApplication.runtimeApi, serverAvailability: options.serverAvailabilityProvider?.() }), restart_server_available: options.restartServerAvailable === true } };
    },
    'runtime.pause': ({ request }) => {
      const rejection = rejectSuppliedRuntimeControlBody(request.body);
      if (rejection) return rejection;
      if (!options.runtimeApplication) throw new Error('Runtime application is required for runtime pause.');
      options.runtimeApplication.runtimeControl.pause();
      return { body: { ...buildRuntimeStatusReadModel({ runtimeApi: options.runtimeApplication.runtimeApi, serverAvailability: options.serverAvailabilityProvider?.() }), restart_server_available: options.restartServerAvailable === true } };
    },
    'runtime.resume': ({ request }) => {
      const rejection = rejectSuppliedRuntimeControlBody(request.body);
      if (rejection) return rejection;
      if (!options.runtimeApplication) throw new Error('Runtime application is required for runtime resume.');
      options.runtimeApplication.runtimeControl.resume();
      return { body: { ...buildRuntimeStatusReadModel({ runtimeApi: options.runtimeApplication.runtimeApi, serverAvailability: options.serverAvailabilityProvider?.() }), restart_server_available: options.restartServerAvailable === true } };
    },
    stop_project: async ({ request }) => {
      const rejection = rejectSuppliedRuntimeControlBody(request.body);
      if (rejection) return rejection;
      if (!options.runtimeApplication) throw new Error('Runtime application is required for project stop.');
      try { return { body: await options.runtimeApplication.runtimeControl.stopProject() }; }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'runtime_control_conflict') return { statusCode: 409, body: { code: 'runtime_control_conflict', message: error.message } };
        throw error;
      }
    },
    restart_server: ({ reply }) => {
      if (!options.restartServerAvailable) return { statusCode: 403, body: { code: 'restart_unavailable', message: 'restart unavailable: operator authentication disabled' } };
      const restartPort = options.restartPort;
      if (!restartPort) throw new Error('Restart port is unavailable.');
      restartPort.schedule();
      reply.raw.once('finish', () => { void restartPort.acknowledge(); });
      return { body: { status: 'restart_scheduled' } };
    },
    'runtime.cardRuns': () => {
      if (!options.runtimeApplication) throw new Error('Runtime application is required for runtime card runs.');
      return { body: buildCardRunsResponse(projectRoot, requireCardService(options.cardStore), options.runtimeApplication.runtimeApi) };
    },
  });
}
