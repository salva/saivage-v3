import type {
  OperatorApiContract,
  OperatorApiHandlerResult,
  OperatorApiOperationId,
} from '../../contracts/index.js';
import type { McpStatusProvider, McpToolsReadModelProvider } from '../../mcp/manager-api.js';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import type { ProviderRoutingReadModel } from '../../agents/provider-routing-read-model.js';
import type { CardService } from '../../cards/card-api.js';
import type { buildServerAvailability } from '../availability.js';
import type { ContractRequestContext } from '../contract-runtime.js';
import type { RestartPort } from '../../boot/restart-port.js';
import type { ResolvedConfigAuthority } from '../../config/index.js';

export type OperatorContractHandler<K extends OperatorApiOperationId> = (
  context: ContractRequestContext<OperatorApiContract<K>>,
) => OperatorApiHandlerResult<K> | Promise<OperatorApiHandlerResult<K>>;
export type OperatorContractHandlerMap = {
  [K in OperatorApiOperationId]: OperatorContractHandler<K>;
};
export type OperatorContractHandlerSubset = {
  [K in OperatorApiOperationId]?: OperatorContractHandler<K>;
};

export function defineOperatorContractHandlers<const TOperationId extends OperatorApiOperationId>(
  handlers: { [K in TOperationId]: OperatorContractHandler<K> },
): { [K in TOperationId]: OperatorContractHandler<K> } {
  return handlers;
}
export type OperatorServerAvailabilityProvider = () => ReturnType<typeof buildServerAvailability>;

export interface OperatorProjectContext {
  projectRoot: string;
}

export interface OperatorCardServiceContext {
  cardStore?: CardService;
}

export interface OperatorRuntimeProviderContext {
  runtimeApplication?: RuntimeApplication;
  restartPort?: RestartPort;
  restartServerAvailable?: boolean;
}

export interface OperatorAvailabilityContext {
  serverAvailabilityProvider?: OperatorServerAvailabilityProvider;
}

export interface OperatorMcpProviderContext {
  mcpStatusProvider?: McpStatusProvider;
  mcpToolsProvider?: McpToolsReadModelProvider;
}

export interface OperatorConfigContext {
  configAuthority: ResolvedConfigAuthority;
  providerRoutingReadModelProvider: () => ProviderRoutingReadModel;
}
