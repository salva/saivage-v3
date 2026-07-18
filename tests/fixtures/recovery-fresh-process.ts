import { CardService } from '../../src/cards/card-service.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error('project root is required');
const cards = new CardService(projectRoot);
const runtime = new SupervisorRuntimeApi({
  ...testAutonomousCompaction,
  projectRoot,
  actorStore: cards,
  interventionBinding: new RuntimeInterventionBinding(),
  provider: { completeTurn: (_input, signal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
  conversations: { projectRoot }, appLogs: { projectRoot },
  readModelChanges: { runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
  processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()),
  promptTemplates: { render: () => 'test prompt' },
});
const prepared = await runtime.beginStartProject();
if (!prepared.accepted) throw new Error('fresh process Run was rejected');
runtime.launchStartedProject(prepared.launch);
for (let count = 0; count < 500 && readConversation(projectRoot, 'planner:project').sourceRows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open')).length < 2; count += 1) await new Promise((resolve) => setTimeout(resolve, 2));
await runtime.stopProject();
process.stdout.write(JSON.stringify({ cards: cards.list().map(({ id, status }) => ({ id, status })), markerCount: readConversation(projectRoot, 'planner:project').sourceRows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open')).length, noticeCount: readConversation(projectRoot, 'planner:project').sourceRows.filter((row) => row.kind === 'model_recovered').length }));
