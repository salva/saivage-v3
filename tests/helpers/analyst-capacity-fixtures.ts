import { jest } from '@jest/globals';
import { AnalystSession } from '../../src/runtime/actors/analyst-session.js';
import type { LLMProviderPort, CompactorPort } from '../../src/runtime/actors/llm-actor.js';
import type { AnalystOrientationCard } from '../../src/application/read-models/analyst-orientation.js';
import type { CardService as CardServicePort } from '../../src/cards/store-api.js';
import { CardService } from './canonical-project.js';
import { scriptedAdmissionProvider, scriptedBindings, testCompactionPolicy, unusedSummarizerProvider } from './llm-test-helpers.js';
import { testApplicationFatalPort } from './test-application-fatal-port.js';
import type { InvocationSurface } from '../../src/tools/invocation.js';
import type { Candidate } from '../../src/contracts/index.js';

export function wideOrientation(): AnalystOrientationCard[] {
  const children = Array.from({ length: 300 }, (_, i) => `card-${'a'.repeat(i + 1)}`);
  return [
    { id: 'project', parent: null, children, type: 'project', status: 'backlog', title: 'Project', version_seq: 1 },
    ...children.map((id, i) => ({ id, parent: 'project', children: [], type: `type-${'a'.repeat(56)}${String(i).padStart(3, '0')}`, status: 'backlog' as const, title: 'Child', version_seq: 1 })),
  ];
}

export function capacityAdmission(kind: 'local_admission_failed' | 'local_compaction_required' = 'local_admission_failed') {
  return {
    kind, routePass: { kind: 'ordinary' as const, candidateChain: [{ provider: 'test', account: null, model: 'test-model' }] }, bindings: scriptedBindings(),
    candidates: [{ candidate: { provider: 'test', account: null, model: 'test-model' }, capabilityRequest: {}, capabilityRequestSha256: '0'.repeat(64), kind: 'projection_too_large' as const, protocol: 'openai-chat-completions', requestHash: '0'.repeat(64), serializedBytes: 40000, estimatedInputTokens: 10000, requestedCompletionTokens: 1000, usableInputTokens: 100, contextWindowTokens: 2000 }],
  };
}

export function analystCapacityFixture(projectRoot: string, overrides: {
  provider?: LLMProviderPort; compactor?: CompactorPort; cardStore?: CardServicePort;
  render?: () => string; surface?: InvocationSurface; runtimeProjectionChanged?: () => void;
  candidateChain?: Candidate[];
} = {}) {
  const complete = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'fresh success' }, provider_exchanges: [] }));
  const store = overrides.cardStore ?? new CardService(projectRoot);
  const session = new AnalystSession({
    cardTypeVocabulary: ['project'], sessionId: 'agent:analyst:global', agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: {},
    candidateChain: overrides.candidateChain ?? [{ provider: 'test', account: null, model: 'test-model' }], routeUsableInputTokens: 80000,
    promptTemplates: { render: overrides.render ?? (() => 'Analyst') }, restartCapability: { available: false },
    provider: overrides.provider ?? scriptedAdmissionProvider(complete), conversations: { projectRoot }, compactionPolicy: testCompactionPolicy,
    compactor: overrides.compactor ?? { shouldCompact: () => false, compact: async () => { throw new Error('unexpected compaction'); } }, summarizerProvider: unusedSummarizerProvider,
    cardStore: store, runtimeCurrent: () => ({ status: 'stopped', currentCardId: null }), runtimeProjectionChanged: overrides.runtimeProjectionChanged ?? (() => {}),
    createInvocationSurface: () => overrides.surface ?? { agentName: 'analyst', tools: new Map(), providers: [] }, shutdownProcesses: async () => {}, fatalPort: testApplicationFatalPort,
  });
  return { session, complete, store };
}
