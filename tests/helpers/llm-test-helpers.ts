import type { LlmCompleteOptions, LlmCompleteResult, ProviderTurnCompletion, ToolCall } from '../../src/agents/llm-contracts.js';
import { compact, shouldCompact, type AutonomousCompactionPolicy } from '../../src/runtime/actors/compaction/compactor.js';
import type { CompactorPort, LLMProviderPort } from '../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput, PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { OrdinaryAdmittedExecution, OrdinaryAdmittedExecutionAuthority, PinnedAdmittedContentPolicyRequest } from '../../src/agents/invocation-admission.js';
import { ordinaryAdmittedExecutionAuthority } from '../../src/agents/invocation-admission.js';
import type { CandidateRequestPlan } from '../../src/agents/candidate-request.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import type { SummarizerProviderPort } from '../../src/runtime/actors/compaction/summarizer.js';
import { bindRuntimeWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import type { McpToolInvocationPort } from '../../src/mcp/manager-api.js';
import { ChildInvocationLease } from '../../src/runtime/actors/child-invocation-wait.js';
import type { LlmToolInvocationContext, ToolInvocationIdentity } from '../../src/runtime/actors/executing-llm-snapshot.js';
import { TEST_WORKFLOWS } from './canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from './test-saivage-config.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';

export const testCompactionPolicy: AutonomousCompactionPolicy = {
  input_budget_tokens: 100_000,
  trigger_fraction: 0.8,
  completion_reserve_fraction: 0.2,
  merge_line_fraction: 0.3,
  summary_line_fraction: 0.5,
  escalate_merge_line_fraction: 0.4,
  escalate_summary_line_fraction: 0.6,
  snap: 'compact_straddler',
};

const scriptedCandidate = { provider: 'test', account: null, model: 'test-model' } as const;

function scriptedPlan(): CandidateRequestPlan {
  return {
    candidate: scriptedCandidate,
    capabilities: { transportProtocol: 'openai-chat-completions', toolsMode: 'native', exclusiveToolChoiceSupport: 'native', quirks: [] },
    adapter: selectLlmProtocolAdapter('openai-chat-completions'),
    request: { body: {}, serializedBody: '{}', estimatedWireInputTokens: 1, requestHash: '0'.repeat(64) },
  };
}

function scriptedAdmission(): OrdinaryAdmittedExecution {
  const authority: OrdinaryAdmittedExecutionAuthority = ordinaryAdmittedExecutionAuthority([scriptedCandidate]);
  const plan = scriptedPlan();
  return Object.freeze({
    kind: 'admitted',
    routePass: { kind: 'ordinary' as const, candidateChain: [scriptedCandidate] },
    candidates: Object.freeze([Object.freeze({ kind: 'admitted', plan, candidate: scriptedCandidate, capabilityRequest: Object.freeze({}), capabilityRequestSha256: '0'.repeat(64) })]),
    executionAuthority: authority,
    bindings: scriptedBindings(),
    execution: Object.freeze({ sessionId: 'agent:planner:project', capabilityRequest: Object.freeze({}), options: toolsOpts() }),
  });
}

export function scriptedBindings() {
  return Object.freeze({
    inputId: 'scripted', sessionId: 'agent:planner:project', agentName: 'planner' as never, sourceSessionId: 'agent:planner:project',
    systemPromptSha256: '0'.repeat(64), toolsSha256: '0'.repeat(64), terminalToolNamesSha256: '0'.repeat(64),
    capabilityRequest: Object.freeze({}), capabilityRequestSha256: '0'.repeat(64), temperature: 0,
    requestedCompletionTokens: 1, inputBudgetTokens: null, preparedCompactionSha256: '0'.repeat(64),
  });
}

export function scriptedOrdinaryAdmission(): OrdinaryAdmittedExecution {
  return scriptedAdmission();
}

export function scriptedPinnedAdmittedPreflight(): PinnedAdmittedContentPolicyRequest {
  return scriptedPinnedPreflight();
}

function scriptedPinnedPreflight(): PinnedAdmittedContentPolicyRequest {
  return Object.freeze({ kind: 'admitted', plan: scriptedPlan(), candidate: scriptedCandidate, capabilityRequest: Object.freeze({}), sessionId: 'agent:planner:project', inputId: 'scripted', options: toolsOpts() });
}

export function scriptedAdmissionProvider<S extends LlmInvocationInput>(script: (input: S, signal: AbortSignal) => Promise<ProviderTurnCompletion>): LLMProviderPort {
  let ordinaryInput: PreparedLlmInvocationInput | undefined;
  let pinnedInput: LlmInvocationInput | undefined;
  const admission = scriptedAdmission();
  const pinned = scriptedPinnedPreflight();
  return {
    preparePrimaryRequestAdmission: (input) => { ordinaryInput = input; return admission; },
    executeAdmittedWithRecovery: (_admission, signal) => {
      if (!ordinaryInput) return Promise.reject(new Error('Scripted provider executed an ordinary turn before admission.'));
      return script(ordinaryInput as S, signal);
    },
    prepareAdmittedRecovery: () => { throw new Error('Unexpected admitted recovery preparation in scripted provider.'); },
    resumeAdmittedExecution: () => Promise.reject(new Error('Unexpected admitted recovery resume in scripted provider.')),
    preflightPinnedContentPolicyRequest: (input) => { pinnedInput = input; return pinned; },
    executePinnedContentPolicyRequest: (_preflight, signal) => {
      if (!pinnedInput) return Promise.reject(new Error('Scripted provider executed a pinned turn before preflight.'));
      return script(pinnedInput as S, signal);
    },
  };
}

export const testCompactor: CompactorPort = { shouldCompact, compact };
export const unusedSummarizerProvider: SummarizerProviderPort = {
  candidate:{provider:'test',account:null,model:'test-model'},
  completeTurn: () => Promise.reject(new Error('Unexpected summarizer call in test.')),
  projectProviderExchanges: () => { throw new Error('Unexpected summarizer exchange projection in test.'); },
};
export const unusedMcpToolInvocation: McpToolInvocationPort = {
  getServerTools: () => { throw new Error('Unexpected MCP server tools read in test.'); },
  findToolCapability: () => { throw new Error('Unexpected MCP capability read in test.'); },
  invokeTool: () => Promise.reject(new Error('Unexpected MCP invocation in test.')),
};

export function testLlmToolInvocationContext(overrides: Partial<ToolInvocationIdentity> = {}): LlmToolInvocationContext {
  const identity: ToolInvocationIdentity = Object.freeze({
    sessionId: 'agent:executor:card-a',
    sourceInputId: '11111111-1111-4111-8111-111111111111',
    toolCallId: 'test-tool-call',
    toolName: 'test_tool',
    ...overrides,
  });
  let lease: ChildInvocationLease | null = null;
  return Object.freeze({
    ...identity,
    waits: Object.freeze({
      waitExternal: <T>(promise: Promise<T>) => promise,
      waitProcess: <T>(_processId: string, promise: Promise<T>) => promise,
    }),
    childInvocation: Object.freeze({
      identity,
      reserveChild: (childCardId: string) => {
        if (lease && lease.childCardId !== childCardId) throw new Error(`Already reserved '${lease.childCardId}'.`);
        lease ??= new ChildInvocationLease(identity, childCardId);
        return lease;
      },
    }),
  });
}

export const testAutonomousCompaction = {
  processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' },
  compactor: testCompactor,
  compactionConfig: testCompactionPolicy,
  summarizerProvider: unusedSummarizerProvider,
  mcpToolInvocation: unusedMcpToolInvocation,
  workflows: bindRuntimeWorkflows(TEST_WORKFLOWS,new ModelRouter(new ProviderRegistry(TEST_SAIVAGE_CONFIG))),
};

export function toolsOpts(extra: Partial<LlmCompleteOptions> = {}): LlmCompleteOptions {
  return { inputId: 'test:input:1', temperature: 0, max_tokens: 2000, tools: [], tool_choice: 'auto', contract_id: 'test.v1', contractName: 'test', terminalToolOffered: [], ...extra };
}

export function asMessage(value: LlmCompleteResult | ProviderTurnCompletion): { content: string; tool_calls: ToolCall[]; finishReason: string } {
  const r = 'result' in value ? value.result : value;
  if (r.kind === 'message') return { content: r.content, tool_calls: [], finishReason: 'stop' };
  return { content: '', tool_calls: r.tool_calls, finishReason: 'tool_calls' };
}

export function makeCodexJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url');
  return `${header}.${payload}.sig`;
}
