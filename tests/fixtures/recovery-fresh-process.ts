import { CardService, TEST_RUNTIME_WORKFLOWS } from '../helpers/canonical-project.js';
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error('project root is required');
const cards = new CardService(projectRoot);
const processRegistry = new ManagedProcessGroupRegistry();
const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime-cards');
const runtime = createSupervisorRuntimeApi({
  fatalPort: testApplicationFatalPort,
  ...testAutonomousCompaction,
  runtimeGate: new RuntimeGate(),
  projectRoot,
  actorStore: cards,
  workflows: TEST_RUNTIME_WORKFLOWS,
  provider: scriptedAdmissionProvider((_input: LlmInvocationInput, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))),
  conversations: { projectRoot },
  freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
  processRunner: new ProcessRunner(projectRoot, processRegistry, testApplicationFatalPort),
  runtimeProcessRootScope,
  promptTemplates: { render: () => 'test prompt' },
});
await runtime.start();
const beforeRun = { cards: cards.list().map(({ id, lifecycle }) => ({ id, status: lifecycle.status })), status: runtime.getStatus(), noticeCount: readConversation(projectRoot, 'agent:planner:project').sourceRows.filter((row) => row.kind === 'model_recovered').length };
if (process.argv[3] === 'startup-only') {
  process.stdout.write(JSON.stringify(beforeRun));
  process.exit(0);
}
const started = await runtime.startProject();
if (!started.started) throw new Error('fresh process Run was rejected');
for (let count = 0; count < 500 && readConversation(projectRoot, 'agent:planner:project').sourceRows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open')).length < 2; count += 1) await new Promise((resolve) => setTimeout(resolve, 2));
await runtime.stopProject();
process.stdout.write(JSON.stringify({ beforeRun, cards: cards.list().map(({ id, lifecycle }) => ({ id, status: lifecycle.status })), markerCount: readConversation(projectRoot, 'agent:planner:project').sourceRows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open')).length, noticeCount: readConversation(projectRoot, 'agent:planner:project').sourceRows.filter((row) => row.kind === 'model_recovered').length }));
