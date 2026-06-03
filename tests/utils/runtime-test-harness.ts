import type { AgentExecutionPort } from '../../src/contracts/index.js';
import { createRuntimeCoreTestContainer, type RuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';
import type { RuntimeConfig } from '../../src/runtime/runtime-config.js';

export interface RuntimeTestHarness extends RuntimeCoreTestContainer {}

export function createRuntimeTestHarness(input: {
  config: RuntimeConfig;
  agentRuntime?: AgentExecutionPort;
  goalDispatcher?: RuntimeConfig['goalDispatcher'];
}): RuntimeTestHarness {
  return createRuntimeCoreTestContainer(input);
}
