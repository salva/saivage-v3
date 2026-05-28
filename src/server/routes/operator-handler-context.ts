import type { SaivageConfig } from '../../agents/config-api.js';
import type { operatorApiContracts } from '../../contracts/index.js';
import type { McpStatusProvider, McpToolsReadModelProvider } from '../../mcp/manager-api.js';
import type { ActiveRuntime } from '../../runtime/control-api.js';
import type { buildServerAvailability } from '../availability.js';
import type { ContractHandler } from '../contract-runtime.js';

export type OperatorContractHandlerMap = Partial<Record<keyof typeof operatorApiContracts, ContractHandler>>;
export type OperatorActiveRuntimeProvider = () => ActiveRuntime | undefined;
export type OperatorServerAvailabilityProvider = () => ReturnType<typeof buildServerAvailability>;
export type OperatorRestartRequester = () => Promise<void>;

export interface OperatorProjectContext {
  projectRoot: string;
}

export interface OperatorRuntimeProviderContext {
  activeRuntimeProvider: OperatorActiveRuntimeProvider;
}

export interface OperatorStaticRuntimeContext {
  activeRuntime?: ActiveRuntime;
}

export interface OperatorAvailabilityContext {
  serverAvailabilityProvider?: OperatorServerAvailabilityProvider;
}

export interface OperatorMcpProviderContext {
  mcpStatusProvider?: () => McpStatusProvider | undefined;
  mcpToolsProvider?: () => McpToolsReadModelProvider | undefined;
}

export interface OperatorRestartContext {
  requestServerRestart?: OperatorRestartRequester;
}

export interface OperatorConfigContext {
  saivageConfig?: SaivageConfig;
  configWarnings?: readonly string[];
}
