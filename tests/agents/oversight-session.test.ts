import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OversightSession } from '../../src/agents/oversight-session.js';
import type { ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import type { LLMProviderPort } from '../../src/runtime/actors/llm-actor.js';
import type { InvocationSurface } from '../../src/tools/invocation.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { scriptedAdmissionProvider, testCompactionPolicy, testCompactor, unusedSummarizerProvider } from '../helpers/llm-test-helpers.js';
import { testApplicationFatalDelivery, testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { globalAgentConversationRoot } from '../../src/persistence/layout.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { z } from 'zod';
import { defineTool, executedToolOutcome, OPERATIONAL_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { toolSucceeded } from '../../src/contracts/tool-result.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { SummaryPromptPolicyBlockedError } from '../../src/runtime/actors/compaction/summarizer.js';
import type { CompactorPort } from '../../src/runtime/actors/llm-actor.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'oversight-session-'));
  roots.push(root);
  initProjectTree(root);
  return root;
}

function session(root: string, provider: LLMProviderPort, runtimeProjectionChanged = () => {}, surface: InvocationSurface = { agentName: 'oversight', tools: new Map(), providers: [] }, compactor: CompactorPort = testCompactor): OversightSession {
  return new OversightSession({
    sessionId: 'agent:oversight:global',
    agentName: 'oversight',
    surface,
    provider,
    conversations: { projectRoot: root, changes: { conversationChanged() {}, agentMembershipChanged: runtimeProjectionChanged } },
    promptTemplates: { render: () => 'Perform proportionate project oversight.' },
    modelParams: { temperature: 0.2, maxTokens: 1000 },
    capabilityRequest: { requiresTools: false, requiresExclusiveToolChoice: true },
    candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
    routeUsableInputTokens: 80_000,
    compactionPolicy: testCompactionPolicy,
    compactor,
    summarizerProvider: unusedSummarizerProvider,
    runtimeProjectionChanged,
    fatalPort: testApplicationFatalPort,
    cardTypeVocabulary: ['project','goal','code'],
  });
}

const finalMessage = (): ProviderTurnCompletion => ({ result: { kind: 'message', content: 'No action needed.' }, provider_exchanges: [] });

describe('OversightSession owned check settlement', () => {
  it('renders the compiled global vocabulary values for every check', async () => {
    const root = projectRoot();
    const render = jest.fn((_purpose, _agent, values: Record<string, string>) => values.vocabularySnippet);
    const check = new OversightSession({
      sessionId:'agent:oversight:global',agentName:'oversight',surface:{agentName:'oversight',tools:new Map(),providers:[]},provider:scriptedAdmissionProvider(async()=>finalMessage()),conversations:{projectRoot:root,changes:{conversationChanged(){},agentMembershipChanged(){}}},promptTemplates:{render} as never,modelParams:{temperature:0.2,maxTokens:1000},capabilityRequest:{requiresTools:false,requiresExclusiveToolChoice:true},candidateChain:[{provider:'test',account:null,model:'test-model'}],routeUsableInputTokens:80_000,compactionPolicy:testCompactionPolicy,compactor:testCompactor,summarizerProvider:unusedSummarizerProvider,runtimeProjectionChanged(){},fatalPort:testApplicationFatalPort,cardTypeVocabulary:['project','custom-leaf'],
    });
    await expect(check.run()).resolves.toBe('succeeded');
    expect(render).toHaveBeenCalledWith({kind:'global-agent'},'oversight',{vocabularySnippet:expect.stringContaining('custom-leaf')});
  });

  it('creates no conversation eagerly and invalidates global membership at first ingress publication', async () => {
    const root = projectRoot();
    const changed = jest.fn();
    expect(existsSync(globalAgentConversationRoot(root, 'oversight'))).toBe(false);
    const check = session(root, scriptedAdmissionProvider(async () => finalMessage()), changed);
    expect(existsSync(globalAgentConversationRoot(root, 'oversight'))).toBe(false);
    await expect(check.run()).resolves.toBe('succeeded');
    expect(existsSync(globalAgentConversationRoot(root, 'oversight'))).toBe(true);
    expect(changed).toHaveBeenCalled();
  });

  it('settles an ordinary final response and permits a later check on the same durable session', async () => {
    const root = projectRoot();
    const complete = jest.fn(async () => finalMessage());
    await expect(session(root, scriptedAdmissionProvider(complete)).run()).resolves.toBe('succeeded');
    await expect(session(root, scriptedAdmissionProvider(complete)).run()).resolves.toBe('succeeded');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('settles a prompt-policy summary block as one failed check and lets a fresh check reuse the canonical session', async () => {
    const root = projectRoot();
    const complete = jest.fn(async () => finalMessage());
    const compact = jest.fn<CompactorPort['compact']>()
      .mockRejectedValueOnce(new SummaryPromptPolicyBlockedError('00000000-0000-4000-8000-000000000099', new Error('RAW PROVIDER FLAG')))
      .mockImplementationOnce(async ({ input }) => ({ kind: 'compacted' as const, providerConversation: input.providerConversation, estimatedProviderMessageTokens: 1 }));
    const compactor: CompactorPort = { shouldCompact: () => true, compact };

    await expect(session(root, scriptedAdmissionProvider(complete), () => {}, undefined, compactor).run()).resolves.toBe('failed');
    expect(complete).not.toHaveBeenCalled();
    expect(readConversation(root, 'agent:oversight:global').sourceRows.some((row) => row.content.includes('RAW PROVIDER FLAG'))).toBe(false);

    await expect(session(root, scriptedAdmissionProvider(complete), () => {}, undefined, compactor).run()).resolves.toBe('succeeded');
    expect(compact).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('invalidates scoped membership after outer check ownership clears', async () => {
    const root = projectRoot();
    let release!: () => void;
    let check!: OversightSession;
    const snapshots: boolean[] = [];
    const changed = jest.fn(() => snapshots.push(check.executingLlmSnapshot() !== null));
    const provider = scriptedAdmissionProvider(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return finalMessage();
    });
    check = session(root, provider, changed);
    const task = check.run();
    while (!release) await Promise.resolve();
    snapshots.length = 0;
    release();
    await expect(task).resolves.toBe('succeeded');
    expect(changed).toHaveBeenCalled();
    expect(snapshots.at(-1)).toBe(false);
  });

  it('classifies known local exact-admission failure as reusable ordinary failure', async () => {
    const root = projectRoot();
    const base = scriptedAdmissionProvider(async () => finalMessage());
    const provider: LLMProviderPort = {
      ...base,
      preparePrimaryRequestAdmission(input, signal) {
        const admitted = base.preparePrimaryRequestAdmission(input, signal);
        return { kind: 'local_admission_failed', routePass: admitted.routePass, candidates: admitted.candidates, bindings: admitted.bindings };
      },
    };
    await expect(session(root, provider).run()).resolves.toBe('failed');
    await expect(session(root, scriptedAdmissionProvider(async () => finalMessage())).run()).resolves.toBe('succeeded');
  });

  it('settles provider cancellation without turning it into owner failure', async () => {
    const root = projectRoot();
    let entered!: () => void;
    const provider = scriptedAdmissionProvider(async (_input, signal) => {
      entered();
      return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const check = session(root, provider);
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const task = check.run();
    await providerEntered;
    expect(()=>check.assertEffectSignal(new AbortController().signal)).toThrow(/does not belong/);
    check.cancel(new Error('runtime paused'));
    await expect(task).resolves.toBe('cancelled');
  });

  it('publishes an entered tool result exactly once when cancellation wins after executor entry',async()=>{
    const root=projectRoot();const reason=new Error('runtime paused');let check!:OversightSession;let providerCalls=0;let executions=0;
    const definition=defineTool({name:'probe',description:'bounded probe',resultPolicyTemplate:OPERATIONAL_RESULT_POLICY_TEMPLATE,inputSchema:z.object({}).strict(),executor:async()=>{executions+=1;check.cancel(reason);return executedToolOutcome('none',toolSucceeded({known:true}));}});
    const surface:InvocationSurface={agentName:'oversight',tools:new Map([[definition.name,definition]]),providers:[{providerName:'probe',tools:[definition]}]};
    const provider=scriptedAdmissionProvider(async()=>{providerCalls+=1;if(providerCalls>1)throw new Error('cancelled check continued to the model');return{result:{kind:'tool_calls',tool_calls:[{id:'probe-1',type:'function',function:{name:'probe',arguments:'{}'}}]},provider_exchanges:[]};});
    check=session(root,provider,()=>{},surface);
    await expect(check.run()).resolves.toBe('cancelled');
    expect(executions).toBe(1);expect(providerCalls).toBe(1);
    const rows=readConversation(root,'agent:oversight:global').physicalRows;
    expect(rows.filter((row)=>row.kind==='tool_call'&&row.tool_call_id==='probe-1')).toHaveLength(1);
    const results=rows.filter((row)=>row.kind==='tool_result'&&row.tool_call_id==='probe-1');expect(results).toHaveLength(1);expect(results[0]!.content).toContain('known');
  });

  it('rejects an unexpected provider-boundary invariant instead of masking it as ordinary failure', async () => {
    const root = projectRoot();
    const failure = new Error('provider invariant');
    const check = session(root, scriptedAdmissionProvider(async () => { throw failure; }));
    await expect(check.run()).rejects.toBe(failure);
  });

  it('delivers publication uncertainty to the nonreturning fatal boundary rather than ordinary failure',async()=>{
    const root=projectRoot();const publication=new PublicationOutcomeUnknownError();
    const check=session(root,scriptedAdmissionProvider(async()=>{throw publication;}));
    await expect(check.run()).rejects.toBe(testApplicationFatalDelivery);
  });
});
