import { join } from 'node:path';
import type { AgentExecutionPort, RuntimeActivationLedgerPort } from '../contracts/index.js';
import type { RuntimeConfig, RuntimeStampSource } from './runtime-config.js';
import { createDefaultAgentExecution } from './default-agent-execution.js';
import { appendRuntimeRun, readRuntimeState, upsertRuntimeActivation } from './state.js';

type ConfigurableAgentRuntime = AgentExecutionPort & {
  setSaivageDir?: (saivageDir: string) => void;
  setActivationLedger?: (activationLedger: RuntimeActivationLedgerPort) => void;
  setSessionStamper?: (sessionStamper: RuntimeStampSource) => void;
};

export function createConfiguredAgentRuntime(input: {
  config: RuntimeConfig;
  sessionStamper: RuntimeStampSource;
  agentRuntime?: AgentExecutionPort;
}): AgentExecutionPort {
  const activationLedger: RuntimeActivationLedgerPort = {
    readState: () => readRuntimeState(input.config.projectRoot),
    appendRun: (run) => appendRuntimeRun(input.config.projectRoot, run),
    upsertActivation: (activation) => upsertRuntimeActivation(input.config.projectRoot, activation),
  };
  const runtime =
    input.agentRuntime ??
    (input.config.agentExecutionFactory ?? createDefaultAgentExecution)(
      input.config.projectRoot,
      {
        ...input.config.fakeAgentConfig,
        saivageDir: join(input.config.projectRoot, '.saivage'),
        sessionStamper: input.sessionStamper,
      },
      activationLedger,
    );
  const configurable = runtime as ConfigurableAgentRuntime;
  configurable.setSaivageDir?.(join(input.config.projectRoot, '.saivage'));
  configurable.setActivationLedger?.(activationLedger);
  configurable.setSessionStamper?.(input.sessionStamper);
  return runtime;
}
