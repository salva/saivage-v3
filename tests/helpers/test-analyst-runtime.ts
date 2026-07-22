import { AnalystRuntime, AnalystSession, type AnalystTurnInput } from '../../src/agents/analyst-handler.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import type { LLMProviderPort } from '../../src/runtime/actors/llm-actor.js';
import type { AutonomousCompactionPolicy } from '../../src/runtime/actors/compaction/compactor.js';
import type { ConversationFileContext } from '../../src/persistence/conversation-file.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import type { EventLog } from '../../src/observability/index.js';
import type { CardService } from '../../src/cards/card-api.js';
import type { PromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import type { RestartPort } from '../../src/boot/restart-port.js';
import { createAnalystMutationServices } from '../../src/application/analyst-mutation-services.js';
import { buildRoleSurface } from '../../src/tools/role-invocation-surfaces.js';
import type { TestProcessRunnerComposition } from './test-process-runner.js';

export interface TestAnalystRuntimeOptions {
  projectRoot: string;
  config: SaivageConfig;
  promptTemplates: PromptTemplateRegistry;
  processes: TestProcessRunnerComposition;
  cardStore: CardService;
  runtime: any;
  runtimeControl?: ToolContext['runtimeControl'];
  configAuthority: ToolContext['configAuthority'];
  interventionReadiness: ToolContext['interventionReadiness'];
  mcpToolInvocation: ToolContext['mcpToolInvocation'];
  eventLogger: EventLog;
  eventQueries: ToolContext['eventQueries'];
  provider: LLMProviderPort;
  conversations: ConversationFileContext;
  compactionPolicy: AutonomousCompactionPolicy;
  compactor: any;
  summarizerProvider: any;
  runtimeProjectionChanged(): void;
  captureExecutingLlmSnapshots: ToolContext['captureExecutingLlmSnapshots'];
  restartServerAvailable?: boolean;
  restartPort?: RestartPort;
}

export function createTestAnalystRuntime(options: TestAnalystRuntimeOptions): { runtime: AnalystRuntime; sessions: AnalystSession[]; directScopes: object[]; sessionOperations: Function[]; sessionConstructionInputs: object[]; runtimeOperations: Function[]; runtimeConstructionInput: object } {
  const sessions: AnalystSession[] = [];
  const directScopes: object[] = [];
  const sessionOperations: Function[] = [];
  const sessionConstructionInputs: object[] = [];
  const createSession = (_turn: AnalystTurnInput): AnalystSession => {
    const directScope = options.processes.processRunner.createDirectScope(options.processes.analystProcessRootScope, 'analyst-session:analyst:global', 'operator_session');
    directScopes.push(directScope);
    const createInvocationSurface = () => {
      const notifyCard = options.runtime.notifyCard.bind(options.runtime);
      const analystMutations = createAnalystMutationServices({ projectRoot: options.projectRoot, store: options.cardStore, configAuthority: options.configAuthority, notifyCard, cancelCard: options.runtime.cancelCard.bind(options.runtime) });
      const context: ToolContext = {
        projectRoot: options.projectRoot,
        configAuthority: options.configAuthority,
        interventionReadiness: options.interventionReadiness,
        processRunner: options.processes.processRunner,
        processScope: directScope,
        store: options.cardStore,
        sessionId: 'analyst:global',
        runtime: options.runtime,
        runtimeControl: options.runtimeControl,
        mcpToolInvocation: options.mcpToolInvocation,
        restartServerAvailable: options.restartServerAvailable ?? false,
        actor: 'analyst',
        surface: 'web-chat',
        eventQueries: options.eventQueries,
        captureExecutingLlmSnapshots: options.captureExecutingLlmSnapshots,
        analystMutations,
      };
      return buildRoleSurface({ role: 'analyst', toolContext: context });
    };
    const shutdownProcesses = async () => {
      const report = await options.processes.processRunner.closeAndTerminateDirectScope({ directScope, category: 'operator_session', reason: 'session closed', graceMs: 5_000 });
      if (report.failed.length > 0) throw new Error('Analyst session process containment failed.');
    };
    sessionOperations.push(createInvocationSurface, shutdownProcesses);
    const sessionInput = {
      projectRoot: options.projectRoot,
      sessionId: 'analyst:global' as const,
      config: options.config,
      promptTemplates: options.promptTemplates,
      restartServerAvailable: options.restartServerAvailable ?? false,
      restartPort: options.restartPort,
      provider: options.provider,
      conversations: options.conversations,
      compactionPolicy: options.compactionPolicy,
      compactor: options.compactor,
      summarizerProvider: options.summarizerProvider,
      eventLogger: options.eventLogger,
      cardStore: options.cardStore,
      runtimeProjectionChanged: options.runtimeProjectionChanged,
      createInvocationSurface,
      shutdownProcesses,
    };
    sessionConstructionInputs.push(sessionInput);
    const session = new AnalystSession(sessionInput);
    sessions.push(session);
    return session;
  };
  const getAvailableToolNames = () => [];
  const terminateRoot = (reason: string) => options.processes.processRunner.terminateScopeTree({ rootScope: options.processes.analystProcessRootScope, categories: ['operator_session'], reason, graceMs: 5_000 });
  const runtimeConstructionInput = { createSession, getAvailableToolNames, terminateRoot };
  const runtime = new AnalystRuntime(runtimeConstructionInput);
  return { runtime, sessions, directScopes, sessionOperations, sessionConstructionInputs, runtimeOperations: [createSession, getAvailableToolNames, terminateRoot], runtimeConstructionInput };
}
