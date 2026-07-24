import { CardService } from '../helpers/canonical-project.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error('project root is required');
const cards = new CardService(projectRoot);
const processRegistry = new ManagedProcessGroupRegistry();
const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime-cards');
const runtime = new SupervisorRuntimeApi({
  fatalPort: testApplicationFatalPort,
  ...testAutonomousCompaction,
  projectRoot,
  actorStore: cards,
  interventionBinding: new RuntimeInterventionBinding(),
  provider: { completeTurn: (_input, signal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
  conversations: { projectRoot },
  freshness: { runtimeChanged() {}, agentsChanged() {}, conversationChanged() {} },
  processRunner: new ProcessRunner(projectRoot, processRegistry, testApplicationFatalPort),
  runtimeProcessRootScope,
  promptTemplates: { render: () => 'test prompt' },
});
const started = await runtime.startProject();
if (!started.started) throw new Error('fresh process Run was rejected');
for (let count = 0; count < 500 && readConversation(projectRoot, 'agent:planner:project').sourceRows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open')).length < 2; count += 1) await new Promise((resolve) => setTimeout(resolve, 2));
await runtime.stopProject();
process.stdout.write(JSON.stringify({ cards: cards.list().map(({ id, lifecycle }) => ({ id, status: lifecycle.status })), markerCount: readConversation(projectRoot, 'agent:planner:project').sourceRows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open')).length, noticeCount: readConversation(projectRoot, 'agent:planner:project').sourceRows.filter((row) => row.kind === 'model_recovered').length }));
