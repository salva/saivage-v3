import { join } from 'node:path';
import type { AgentExecutionPort, RuntimeActivationLedgerPort } from '../contracts/index.js';
import type { RuntimeConfig } from './runtime-config.js';
import type { SessionStamper } from './session-stamper.js';
import { FakeAgentAdapter, type FakeAgentConfig } from './fake-agent.js';
import { readRuntimeState } from './state.js';
import type { RuntimeStateMutationPort } from './mutations.js';

type ConfigurableAgentRuntime = AgentExecutionPort & {
  setSaivageDir?: (saivageDir: string) => void;
  setActivationLedger?: (activationLedger: RuntimeActivationLedgerPort) => void;
  setSessionStamper?: (sessionStamper: SessionStamper) => void;
};

export function createDefaultAgentExecution(
  _projectRoot: string,
  fakeAgentConfig: FakeAgentConfig,
  activationLedger: RuntimeActivationLedgerPort,
): AgentExecutionPort {
  return new FakeAgentAdapter({
    ...fakeAgentConfig,
    activationLedger,
  });
}

export function createConfiguredAgentRuntime(input: {
  config: RuntimeConfig;
  sessionStamper: SessionStamper;
  mutations: RuntimeStateMutationPort;
  agentRuntime?: AgentExecutionPort;
}): AgentExecutionPort {
  const activationLedger: RuntimeActivationLedgerPort = {
    readState: () => readRuntimeState(input.config.projectRoot),
    appendRun: (run) => input.mutations.apply({ kind: 'appendRuntimeRun', run }),
    upsertActivation: (activation) => input.mutations.apply({ kind: 'upsertRuntimeActivation', activation }),
  };
  const runtime =
    input.agentRuntime ??
    createDefaultAgentExecution(
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
