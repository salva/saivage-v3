import { FakeAgentAdapter, type FakeAgentConfig } from './fake-agent.js';
import type { AgentExecutionPort } from '../contracts/index.js';

export function createDefaultAgentExecution(_projectRoot: string, fakeAgentConfig: FakeAgentConfig, activationLedger: import('../contracts/index.js').RuntimeActivationLedgerPort): AgentExecutionPort {
  return new FakeAgentAdapter({
    ...fakeAgentConfig,
    activationLedger,
  });
}
