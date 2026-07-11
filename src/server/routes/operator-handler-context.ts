import type { SaivageConfig } from '../../agents/config-api.js';
import type { operatorApiContracts } from '../../contracts/index.js';
import type { McpStatusProvider, McpToolsReadModelProvider } from '../../mcp/manager-api.js';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import type { ProviderRoutingReadModel } from '../../agents/provider-routing-read-model.js';
import type { RuntimeApi } from '../../runtime/control-api.js';
import type { CardStore } from '../../cards/store-api.js';
import type { buildServerAvailability } from '../availability.js';
import type { ContractHandler } from '../contract-runtime.js';
import type { ProcessRunner } from '../../runtime/process-runner.js';
import type { RestartPort } from '../../boot/restart-port.js';

export type OperatorContractHandlerMap = Partial<Record<keyof typeof operatorApiContracts, ContractHandler>>;
export type OperatorServerAvailabilityProvider = () => ReturnType<typeof buildServerAvailability>;

export interface OperatorProjectContext {
  projectRoot: string;
  processRunner?: ProcessRunner;
}

export interface OperatorCardStoreContext {
  cardStore?: CardStore;
}

export interface OperatorRuntimeProviderContext {
  runtimeApplication?: RuntimeApplication;
  restartPort?: RestartPort;
}

export interface OperatorAvailabilityContext {
  serverAvailabilityProvider?: OperatorServerAvailabilityProvider;
}

export interface OperatorMcpProviderContext {
  mcpStatusProvider?: McpStatusProvider;
  mcpToolsProvider?: McpToolsReadModelProvider;
}

export interface OperatorConfigContext {
  saivageConfig?: SaivageConfig;
  configWarnings?: readonly string[];
  providerRoutingReadModelProvider?: () => ProviderRoutingReadModel | undefined;
}
