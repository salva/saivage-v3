import { afterEach, expect, test, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CardService } from '../../../src/cards/card-service.js';
import { publishTestProjectRuntime as publishInitialProjectRuntime } from '../../helpers/initial-project-fixture.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import {
  compileProjectWorkflowDeclarations,
  bindRuntimeWorkflows,
} from '../../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { createObservedCollections } from '../../../src/retrieval/index.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { NO_FRESHNESS_EFFECTS } from '../../../src/contracts/index.js';
import { nativeGitRefs } from '../../../src/runtime/git-workflow.js';
import { readCardExecutions } from '../../../src/persistence/card-execution-log.js';
import {
  createTestProcessRunner,
  cleanupTestProcessRunners,
} from '../../helpers/test-process-runner.js';
import { createPromptTemplateRegistry } from '../../../src/utils/prompt-api.js';
import {
  scriptedAdmissionProvider,
  testAutonomousCompaction,
} from '../../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { compact } from '../../../src/runtime/actors/compaction/compactor.js';
import { deterministicSummarySerialization } from '../../helpers/summary-serialization.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import { canonicalValueSha256 } from '../../../src/schemas/index.js';

const identity = {
  GIT_AUTHOR_NAME: 'Correction fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Correction fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const prior = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupTestProcessRunners(root);
  for (const [key, value] of Object.entries(prior))
    value === undefined ? delete process.env[key] : (process.env[key] = value);
});
function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, {
    cwd: root,
    env: { ...process.env, ...identity },
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) throw new Error(`Fixture Git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture() {
  Object.assign(process.env, identity);
  const root = mkdtempSync(join(tmpdir(), 'native-correction-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.saivage/\n');
  writeFileSync(join(root, 'conflict.txt'), 'base\n');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'B');
  const base = git(root, 'rev-parse', 'HEAD');
  const namespace = 'refs/saivage/correction';
  const branch = nativeGitRefs({ namespace, card_id: 'project' }, randomUUID()).branch_ref;
  git(root, 'switch', '-c', branch.slice('refs/heads/'.length));
  writeFileSync(join(root, 'conflict.txt'), 'original c1\n');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'c1');
  writeFileSync(join(root, 'c2.txt'), 'original c2\n');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'c2');
  const original = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', 'main');
  writeFileSync(join(root, 'conflict.txt'), 'parent\n');
  writeFileSync(join(root, 'parent-only.txt'), 'parent only\n');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'P');
  const parentTip = git(root, 'rev-parse', 'HEAD');
  const config = effectiveSaivageConfigSchema.parse(materializeSystemTemplate(resolveSystemTemplate('classic-git'), {
    delivery_branch: 'main',
    private_ref_namespace: namespace,
    source_roots: ['.'],
    excluded_paths: ['.git', '.saivage'],
  }));
  config.models = structuredClone(TEST_SAIVAGE_CONFIG.models);
  config.providers = structuredClone(TEST_SAIVAGE_CONFIG.providers);
  config.compaction = structuredClone(TEST_SAIVAGE_CONFIG.compaction);
  for (const agent of Object.values(config.agents)) agent.tools = agent.tools.filter(tool => tool !== 'view_image');
  const declarations = compileProjectWorkflowDeclarations(config, { projectRoot: root });
  const registry = new ProviderRegistry(config);
  const workflows = bindRuntimeWorkflows(
      declarations,
      new ModelRouter(registry),
      registry,
      config.compaction.context_utilization_fraction,
      { internalAnalystEnabled: true },
    );
  publishInitialProjectRuntime(root, declarations);
  initProjectTree(root);
  const store = new CardService(root, declarations, NO_FRESHNESS_EFFECTS);
  store.publishGitFacts('project', {
    kind: 'root',
    policy_digest: canonicalValueSha256(workflows.gitPolicy),
    branch_ref: branch,
    observed_tip: original,
    base_oid: base,
    parent: { branch_ref: 'refs/heads/main', observed_tip: parentTip },
    candidate: null,
    last_delivery: null,
    correction: null,
  });
  return {
    root,
    store,
    workflows,
    original,
    base,
    parentTip,
    branch,
    processes: createTestProcessRunner(root),
  };
}
function call(id: string, name: string, args: object) {
  return {
    result: {
      kind: 'tool_calls' as const,
      tool_calls: [
        { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } },
      ],
    },
    provider_exchanges: [],
  };
}

function captureComposition(name: string, value: unknown) {
  const directory = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `native-correction-${name}.json`), JSON.stringify(value, null, 2));
}

test.each(['blocked', 'source_ready'] as const)(
  'real correction Executor rejects premature readiness then %s verifies rewritten O through its owner',
  async (completion) => {
    const f = fixture();
    let turns = 0,
      ordinaryTurns = 0,
      stopped!: () => void;
    const settled = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const supervisor = createSupervisorRuntimeApi({
      ...testAutonomousCompaction,
      workflows: f.workflows,
      retrieval: createObservedCollections(f.root),
      projectRoot: f.root,
      actorStore: f.store,
      conversations: { projectRoot: f.root },
      runtimeGate: new RuntimeGate(),
      processRunner: f.processes.processRunner,
      runtimeProcessRootScope: f.processes.runtimeProcessRootScope,
      processIdentity: { pid: 1, startedAt: '2026-10-26T00:00:00.000Z' },
      promptTemplates: createPromptTemplateRegistry(f.workflows),
      fatalPort: testApplicationFatalPort,
      freshness: NO_FRESHNESS_EFFECTS,
      runtimeStatusChanged: (status) => {
        if (
          status === 'stopped' &&
          ['blocked', 'failed'].includes(f.store.read('project')!.lifecycle.status)
        )
          stopped();
      },
      provider: scriptedAdmissionProvider(async (input) => {
        captureComposition(`${completion}-${input.agentName}-${turns + 1}`, input);
        writeFileSync(join(f.root, '..', `${basename(f.root)}-feedback-${input.sessionId.split(':')[1]}-${turns+1}.json`),JSON.stringify(input,null,2));
        if (input.sessionId === 'agent:planner:project') {
          ordinaryTurns++;
          expect(f.store.read('project')!.git!.correction).toBeNull();
          throw new Error('Ordinary work remains incomplete after verified correction.');
        }
        expect(input.sessionId).toBe('agent:executor:project');
        turns++;
        if (turns === 1)
          return call('premature', 'emit_result', {
            outcome: 'source_ready',
            summary: 'Needs verification.',
          });
        if (turns === 2) {
          const refusal = input.providerConversation.messages.find(row => row.kind === 'tool_result' && row.tool_call_id === 'premature');
          expect(refusal && JSON.parse(refusal.content)).toMatchObject({ success: false });
          expect(f.store.read('project')!.git!.correction).not.toBeNull();
          return call('reconstruct', 'run_command', {
            command: `timeout -k 2s 20s bash -c 'git rebase --merge --onto ${f.parentTip} ${f.base} || test -d .git/rebase-merge; printf "resolved c1\\n" > conflict.txt; git add conflict.txt; GIT_EDITOR=true git rebase --continue'`,
            wait: true,
          });
        }
        if (turns === 3)
          return call('after-rewrite', 'emit_result', {
            outcome: completion,
            summary: 'Source reconstructed; product work still incomplete.',
          });
        throw new Error('Unexpected correction turn.');
      }),
    });
    try {
      await supervisor.startProject();
      await settled;
      const card = f.store.read('project')!;
      expect(card.lifecycle.status).toBe(completion === 'blocked' ? 'blocked' : 'failed');
      expect(turns).toBe(3);
      expect(ordinaryTurns).toBe(completion === 'blocked' ? 0 : 1);
      expect(f.store.readRecordCurrent('project', 'git-correction.md')).toMatchObject({ kind: 'found', value: { projection: null } });
      expect(f.store.readRecordCurrent('project', 'review.md')).toMatchObject({ kind: 'found', value: { projection: null } });
      if (completion === 'source_ready') expect(card.git!.correction).toBeNull();
      else expect(card.git!.correction?.original_tip).toBe(f.original);
      expect(card.git!.observed_tip).not.toBe(f.original);
      expect(git(f.root, 'show', `${card.git!.observed_tip}:c2.txt`)).toBe('original c2');
      expect(git(f.root, 'show', `${card.git!.observed_tip}:parent-only.txt`)).toBe('parent only');
      expect(git(f.root, 'show', `${card.git!.observed_tip}:conflict.txt`)).toBe('resolved c1');
      expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      expect(readFileSync(join(f.root, 'conflict.txt'), 'utf8')).toBe('parent\n');
      const ancestry = spawnSync(
        'git',
        ['merge-base', '--is-ancestor', f.original, card.git!.observed_tip],
        { cwd: f.root, timeout: 5000 },
      );
      expect(ancestry.status).toBe(1);
      const finished = readCardExecutions(f.root, 'project').filter(
        (row) => row.kind === 'native_finished',
      );
      expect(finished.map((row) => row.outcome)).toEqual([
        'correction-required',
        'refused',
        'correction-verified',
        'returned',
      ]);
    } finally {
      await supervisor.cleanupForApplicationStop();
    }
  },
  180000,
);

test.each(['repeat', 'ordinary-publication-failure', 'stop-after-publication', 'prompt-compaction'] as const)('actual Supervisor snapshot frontier %s preserves original C separately', async mode => {
  const f = fixture();
  let round = 0,
    turn = 0,
    ordinary = 0,
    finish!: () => void;
  let originalTask: NonNullable<NonNullable<ReturnType<typeof f.store.read>>['git']>['correction'] =
    null;
  let publishedBefore = f.original;
  let indexBeforeCapture: Buffer | null = null;
  let sourceBeforeCapture: Buffer | null = null;
  let snapshotPublications = 0;
  let observedRunning = false;
  let reached!: () => void;
  const frontier = new Promise<void>(resolve => { reached = resolve; });
  let stop: Promise<unknown> | undefined;
  let compacted=false;
  const preparedRenders:unknown[]=[];
  const publish = f.store.publishGitFacts.bind(f.store);
  jest.spyOn(f.store, 'publishGitFacts').mockImplementation((id, facts) => {
    const previous = f.store.read(id)!.git;
    if (
      facts.correction?.preserved_source &&
      facts.correction.preserved_source.ref !== previous?.correction?.preserved_source?.ref
    ) {
      snapshotPublications++;
      expect(readFileSync(join(f.root, '.git/index'))).toEqual(indexBeforeCapture);
      expect(readFileSync(join(f.root, 'conflict.txt'))).toEqual(sourceBeforeCapture);
      expect(readFileSync(join(f.root, '.git/rebase-merge/orig-head'), 'utf8').trim()).not.toBe('');
      if (mode === 'ordinary-publication-failure') {
        reached();
        throw new Error('Known snapshot selection failure before publication');
      }
      const selected = publish(id, facts);
      expect(readFileSync(join(f.root, '.git/index'))).toEqual(indexBeforeCapture);
      expect(selected.git!.correction!.preserved_source).toEqual(facts.correction.preserved_source);
      if (mode === 'stop-after-publication') { stop = supervisor.stopProject(); reached(); }
      return selected;
    }
    return publish(id, facts);
  });
  const commands = () => {
    const begin = `git rebase --merge --onto ${f.parentTip} ${f.base} || test -d .git/rebase-merge`;
    if (round === 1)
      return `${begin}; printf "partial one\\n" > conflict.txt; printf "useful one\\n" > useful.txt`;
    if (round === 2)
      return `printf "original c2\\n" > c2.txt; git add c2.txt; git commit -m linear-later-work; ${begin}; printf "partial two\\n" > conflict.txt; printf "useful two\\n" > useful.txt`;
    if (round === 4)
      return `printf "later rewritten change\\n" > conflict.txt; git add conflict.txt; git commit -m rewritten-linear; git rebase --merge --onto ${f.parentTip} ${publishedBefore} || test -d .git/rebase-merge; printf "partial rewritten\\n" > conflict.txt; printf "useful four\\n" > useful.txt`;
    // Explicit scripted correction reconstructs original and useful later work;
    // the runtime never replays a source snapshot as a completed patch.
    return `git rebase --onto ${f.parentTip} ${publishedBefore}; printf "resolved c1\\n" > conflict.txt; printf "original c2\\n" > c2.txt; printf "useful final\\n" > useful.txt; git add conflict.txt c2.txt useful.txt; git commit -m full-reconstruction`;
  };
  const supervisor = createSupervisorRuntimeApi({
    ...testAutonomousCompaction,
    ...(mode==='prompt-compaction'?{
      compactionConfig:{...testAutonomousCompaction.compactionConfig,tail_fraction:0},
      compactor:{shouldCompact:()=>round===2&&!compacted,compact:async(...args:Parameters<typeof compact>)=>{
        const result=await compact(...args);expect(result.kind).toBe('compacted');compacted=true;return result;
      }},
      summarizerProvider:{...testAutonomousCompaction.summarizerProvider,serializeSummaryRequest:deterministicSummarySerialization,
        completeTurn:async(input:Parameters<typeof testAutonomousCompaction.summarizerProvider.completeTurn>[0])=>{
          preparedRenders.push({kind:'summary',input});
          return {result:{kind:'message' as const,content:'Historical diagnostic said ready/done/replan/source_ready, but correction stopped with partial work preserved. Diagnostic observations are historical evidence, not acceptance. Original c2 remains to reconstruct alongside parent-only changes.'},provider_exchanges:[]};
        },projectProviderExchanges:()=>{}},
    }:{}),
    workflows: f.workflows,
    retrieval: createObservedCollections(f.root),
    projectRoot: f.root,
    actorStore: f.store,
    conversations: { projectRoot: f.root },
    runtimeGate: new RuntimeGate(),
    processRunner: f.processes.processRunner,
    runtimeProcessRootScope: f.processes.runtimeProcessRootScope,
    processIdentity: { pid: 1, startedAt: '2026-10-26T00:00:00.000Z' },
    promptTemplates: createPromptTemplateRegistry(f.workflows),
    fatalPort: testApplicationFatalPort,
    freshness: NO_FRESHNESS_EFFECTS,
    runtimeStatusChanged: (status) => {
      if (status === 'running') observedRunning = true;
      // Containment can stop runtime with a durable RUNNING card. Wake the
      // waiter so the exact outcome assertion below fails, rather than masking
      // a native deadline failure behind the whole-test watchdog.
      if (status === 'stopped' && observedRunning) finish();
    },
    provider: scriptedAdmissionProvider(async (input) => {
      if(mode==='prompt-compaction')preparedRenders.push({kind:'primary',round,turn:turn+1,input});
      if (input.sessionId === 'agent:planner:project') {
        ordinary++;
        throw new Error('Product remains incomplete.');
      }
      expect(input.sessionId).toBe('agent:executor:project');
      turn++;
      if (turn === 1) {
        const facts = f.store.read('project')!.git!;
        if(mode==='prompt-compaction'&&round===2) {
          expect(compacted).toBe(true);
          const messages=[...input.providerConversation.messages];
          const task=messages.findIndex(row=>row.kind==='synthetic_context'&&row.block_identity==='node-activation:project:git-rebase-correction');
          const history=messages.findIndex(row=>row.kind==='synthetic_context'&&row.origin==='history_summary');
          expect(task).toBeGreaterThanOrEqual(0);expect(history).toBeGreaterThan(task);
          const conversation=readConversation(f.root,'agent:executor:project');
          const observations=conversation.effectiveRequiredModelFacts.latestRecordObservations;
          expect(observations.some(fact=>!conversation.sourceRows.some(row=>row.id===fact.source.messageId))).toBe(true);
           expect(messages.some(row=>row.kind==='synthetic_context'&&row.block_identity==='latest-record-observations')).toBe(false);
          expect(messages[task]!.content).toContain(facts.correction!.preserved_source!.oid);
          expect(messages[task]!.content).toContain(facts.observed_tip);
          expect(messages[task]!.content).toContain(f.original);
          expect(facts.candidate).toBeNull();
        }
        originalTask ??= facts.correction;
        expect(facts.correction!.original_tip).toBe(f.original);
        expect(facts.observed_tip).toBe(publishedBefore);
        const context = input.providerConversation.messages.find(
          (message) =>
            message.kind === 'synthetic_context' &&
            message.block_identity === 'node-activation:project:git-rebase-correction',
        );
        expect(context).toBeDefined();
        expect(context!.content).toContain(f.original);
        expect(context!.content).toContain(publishedBefore);
        if (facts.correction!.preserved_source)
          expect(context!.content).toContain(facts.correction!.preserved_source.oid);
        writeFileSync(
          join(f.root, '..', `${basename(f.root)}-round${round}-composition.json`),
          JSON.stringify(
            {
              systemPrompt: input.systemPrompt,
              tools: input.tools,
              providerConversation: input.providerConversation,
            },
            null,
            2,
          ),
        );
        return call(`command-${round}`, 'run_command', {
          command: `timeout -k 2s 25s bash -ec '${commands()}'`,
          wait: true,
        });
      }
      if (turn === 2) {
        if(mode==='prompt-compaction'&&round===1)return call('diagnostic-write','write',{path:'record:///git-correction.md?card=project',content:'Diagnostic only: original C retains c2; current partial S is not complete replay. Parent P-only bytes must remain. No product acceptance is asserted.'});
        indexBeforeCapture = readFileSync(join(f.root, '.git/index'));
        sourceBeforeCapture = readFileSync(join(f.root, 'conflict.txt'));
        return call(`result-${round}`, 'emit_result', {
          outcome: round === 5 ? 'source_ready' : 'blocked',
          summary: `Round ${round} source result, no product completion.`,
        });
      }
      if(mode==='prompt-compaction'&&round===1&&turn===3)return call('diagnostic-read','read',{path:'record:///git-correction.md?card=project'});
      if(mode==='prompt-compaction'&&round===1&&turn===4) {
        const rows=[...input.providerConversation.messages];
        const calls=rows.filter(row=>row.kind==='tool_call'&&row.tool_call_id==='diagnostic-read');
        const results=rows.filter(row=>row.kind==='tool_result'&&row.tool_call_id==='diagnostic-read');
        expect(calls).toHaveLength(1);expect(results).toHaveLength(1);
        expect(JSON.parse(calls[0]!.content).tool_calls).toEqual([{
          id:'diagnostic-read',type:'function',function:{name:'read',arguments:JSON.stringify({path:'record:///git-correction.md?card=project'})},
        }]);
        expect(JSON.parse(results[0]!.content)).toMatchObject({success:true,data:{card_id:'project',name:'git-correction.md',state:'open',accepted_version_url:null}});
        expect(rows.indexOf(results[0]!)).toBe(rows.indexOf(calls[0]!)+1);
        const conversation=readConversation(f.root,'agent:executor:project');
        const facts=conversation.effectiveRequiredModelFacts.latestRecordObservations.map(fact=>({...fact,source:conversation.sourceRows.some(row=>row.id===fact.source.messageId)?{messageId:fact.source.messageId,timestamp:fact.source.timestamp}:fact.source}));
        expect(facts.length).toBeGreaterThan(0);
         expect(rows.slice(rows.indexOf(results[0]!)+1)).toEqual([]);
        indexBeforeCapture=readFileSync(join(f.root,'.git/index'));sourceBeforeCapture=readFileSync(join(f.root,'conflict.txt'));
        return call('diagnostic-blocked','emit_result',{outcome:'blocked',summary:'Partial source held; diagnostic read is not acceptance.'});
      }
      throw new Error('Unexpected replay/correction call.');
    }),
  });
  try {
    for (round = 1; round <= (mode==='prompt-compaction'?2:5); round++) {
      turn = 0;
      observedRunning = false;
      const stopped = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await supervisor.startProject();
      if (mode !== 'repeat' && mode !== 'prompt-compaction') {
        await frontier;
        if (stop) await stop; else await supervisor.stopProject();
        expect(turn).toBe(2); expect(ordinary).toBe(0); expect(snapshotPublications).toBe(1);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(indexBeforeCapture);
        expect(readFileSync(join(f.root, 'conflict.txt'))).toEqual(sourceBeforeCapture);
        expect(readFileSync(join(f.root, '.git/rebase-merge/orig-head'), 'utf8').trim()).toBe(f.original);
        const rows = readCardExecutions(f.root, 'project');
        const capture = rows.filter(row => row.kind === 'native_started' && row.step === 'captureRebase').at(-1)!;
        expect(rows.slice(rows.indexOf(capture)).some(row => row.kind === 'native_started' && row.step === 'restoreRebaseAndReturn')).toBe(false);
        expect(git(f.root, 'rev-parse', originalTask!.retained_original_ref)).toBe(f.original);
        expect(f.store.read('project')!.git!.correction!.preserved_source !== null).toBe(mode === 'stop-after-publication');
        return;
      }
      await stopped;
      expect(turn).toBe(mode==='prompt-compaction'&&round===1?4:2);
      const card = f.store.read('project')!,
        facts = card.git!;
      expect(card.lifecycle.status).toBe(round === 5 ? 'failed' : 'blocked');
      expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      expect(git(f.root, 'show', `${originalTask!.retained_original_ref}:c2.txt`)).toBe(
        'original c2',
      );
      expect(git(f.root, 'rev-parse', originalTask!.retained_original_ref)).toBe(f.original);
      if ([1, 2, 4].includes(round)) {
        const snapshot = facts.correction!.preserved_source!;
        expect(git(f.root, 'rev-parse', `${facts.observed_tip}^{tree}`)).toBe(
          git(f.root, 'rev-parse', `${snapshot.oid}^{tree}`),
        );
        expect(snapshot.source_tip).toBe(f.parentTip);
        expect(facts.correction!.original_tip).toBe(f.original);
        expect(git(f.root, 'show', `${facts.observed_tip}:conflict.txt`)).toBe(
          round === 1 ? 'partial one' : round === 2 ? 'partial two' : 'partial rewritten',
        );
      }
      if (round >= 3) {
        const ancestry = spawnSync(
          'git',
          ['merge-base', '--is-ancestor', f.original, facts.observed_tip],
          { cwd: f.root, timeout: 5000 },
        );
        expect(ancestry.status).toBe(1);
      }
      if (round === 3 || round === 5) {
        expect(git(f.root, 'show', `${facts.observed_tip}:c2.txt`)).toBe('original c2');
        expect(git(f.root, 'show', `${facts.observed_tip}:parent-only.txt`)).toBe('parent only');
        expect(git(f.root, 'show', `${facts.observed_tip}:useful.txt`)).toBe('useful final');
      }
      publishedBefore = facts.observed_tip;
    }
    if(mode==='prompt-compaction') {
      expect(compacted).toBe(true);expect(ordinary).toBe(0);
      const conversation=readConversation(f.root,'agent:executor:project');
      expect(conversation.effectiveCompactedHistory).not.toBeNull();
      expect(conversation.effectiveRequiredModelFacts.latestRecordObservations.length).toBeGreaterThan(0);
      return;
    }
    expect(ordinary).toBe(1);
    expect(snapshotPublications).toBe(3);
    expect(f.store.read('project')!.git!.correction).toBeNull();
    const rows = readCardExecutions(f.root, 'project');
    expect(
      rows.filter((row) => row.kind === 'native_finished' && row.outcome === 'captured'),
    ).toHaveLength(3);
    expect(
      rows.filter((row) => row.kind === 'native_finished' && row.outcome === 'correction-verified'),
    ).toHaveLength(2);
    expect(
      rows.filter((row) => row.kind === 'native_finished' && row.outcome === 'returned'),
    ).toHaveLength(5);
  } finally {
    await supervisor.cleanupForApplicationStop();
    if(mode==='prompt-compaction')writeFileSync(join(f.root,'..',`${basename(f.root)}-actual-compaction-contexts.json`),JSON.stringify(preparedRenders,null,2));
    if(mode==='prompt-compaction')captureComposition('compaction',preparedRenders);
  }
}, 900000);

test('actual urgent correction reentry prepares the surviving source task before retained history', async () => {
  const f=fixture();const renders:unknown[]=[];
  let entered!:()=>void,finished!:()=>void,turn=0;
  const first=new Promise<void>(r=>{entered=r;}),stopped=new Promise<void>(r=>{finished=r;});
  const supervisor=createSupervisorRuntimeApi({...testAutonomousCompaction,workflows:f.workflows,retrieval:createObservedCollections(f.root),
    projectRoot:f.root,actorStore:f.store,conversations:{projectRoot:f.root},runtimeGate:new RuntimeGate(),processRunner:f.processes.processRunner,
    runtimeProcessRootScope:f.processes.runtimeProcessRootScope,promptTemplates:createPromptTemplateRegistry(f.workflows),fatalPort:testApplicationFatalPort,
    freshness:NO_FRESHNESS_EFFECTS,runtimeStatusChanged:status=>{if(status==='stopped'&&['blocked','failed'].includes(f.store.read('project')!.lifecycle.status))finished();},
    provider:scriptedAdmissionProvider(async(input,signal)=>{
      turn++;renders.push(input);expect(input.sessionId).toBe('agent:executor:project');
      const task=input.providerConversation.messages.find(row=>row.kind==='synthetic_context'&&row.block_identity==='node-activation:project:git-rebase-correction');
      expect(task?.content).toContain(f.original);expect(f.store.read('project')!.git!.candidate).toBeNull();
      if(turn===1){entered();return new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
      if(turn!==2)throw new Error('Unexpected urgent correction turn');
      // Urgent takeover does not consume the ordinary node's pending mailbox
      // while the source correction task still owns entry.
      expect(f.store.read('project')!.pending_notifications).toHaveLength(1);
      return call('urgent-blocked','emit_result',{outcome:'blocked',summary:'Source correction remains incomplete; urgent notice is not acceptance.'});
    })});
  try {
    await supervisor.startProject();await first;
    const result=await supervisor.submitNotification('project',{id:randomUUID(),content:'Urgent synthetic scope clarification: preserve original C and reconstruct c2; no new product acceptance.',created_at:new Date().toISOString(),source:'fixture'},'urgent');
    expect(result).toMatchObject({queued:true,interruption:{status:'interrupted'}});
    await stopped;expect(turn).toBe(2);expect(f.store.read('project')!.lifecycle.status).toBe('blocked');expect(f.store.read('project')!.git!.correction!.original_tip).toBe(f.original);
  } finally {await supervisor.cleanupForApplicationStop();writeFileSync(join(f.root,'..',`${basename(f.root)}-urgent-contexts.json`),JSON.stringify(renders,null,2));}
},300000);

test('untouched-parent entry refusal publishes runtime Git BLOCKED without a fabricated correction/provider turn', async () => {
  const f = fixture();
  git(f.root, 'switch', f.branch.slice('refs/heads/'.length));
  writeFileSync(join(f.root, 'unattributed.txt'), 'unattributed branch movement\n');
  git(f.root, 'add', '--all');
  git(f.root, 'commit', '-m', 'unattributed');
  const moved = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'switch', 'main');
  let calls = 0,
    finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const supervisor = createSupervisorRuntimeApi({
    ...testAutonomousCompaction,
    workflows: f.workflows,
    retrieval: createObservedCollections(f.root),
    projectRoot: f.root,
    actorStore: f.store,
    conversations: { projectRoot: f.root },
    runtimeGate: new RuntimeGate(),
    processRunner: f.processes.processRunner,
    runtimeProcessRootScope: f.processes.runtimeProcessRootScope,
    processIdentity: { pid: 1, startedAt: '2026-10-26T00:00:00.000Z' },
    promptTemplates: createPromptTemplateRegistry(f.workflows),
    fatalPort: testApplicationFatalPort,
    freshness: NO_FRESHNESS_EFFECTS,
    runtimeStatusChanged: (status) => {
      if (status === 'stopped' && f.store.read('project')!.lifecycle.status === 'blocked') finish();
    },
    provider: scriptedAdmissionProvider(async () => {
      calls++;
      throw new Error('No provider admission expected.');
    }),
  });
  try {
    await supervisor.startProject();
    await stopped;
    expect(calls).toBe(0);
    const card = f.store.read('project')!;
    expect(card.lifecycle.result).toMatchObject({ kind: 'git-workflow-blocked', step: 'enter' });
    expect(card.git!.observed_tip).toBe(f.original);
    expect(git(f.root, 'rev-parse', f.branch)).toBe(moved);
    expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(
      readCardExecutions(f.root, 'project')
        .filter((row) => row.kind === 'native_finished')
        .map((row) => row.outcome),
    ).toEqual(['refused']);
    expect(f.processes.processRunner.list()).toEqual([]);
  } finally {
    await supervisor.cleanupForApplicationStop();
  }
}, 120000);

test.each(['root', 'surviving'] as const)(
  'urgent %s correction captures partial source before the next real correction participant',
  async (target) => {
    const f = fixture();
    const child =
      target === 'surviving'
        ? f.store.create({
            type: 'code',
            parent: 'project',
            title: 'Notification target',
            bootstrap_content: 'Scoped work',
            priority: 0,
            urgency: 'normal',
            created_by: 'analyst',
            depends_on: [],
          })
        : null;
    let turn = 0,
      entered!: () => void,
      finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const supervisor = createSupervisorRuntimeApi({
      ...testAutonomousCompaction,
      workflows: f.workflows,
      retrieval: createObservedCollections(f.root),
      projectRoot: f.root,
      actorStore: f.store,
      conversations: { projectRoot: f.root },
      runtimeGate: new RuntimeGate(),
      processRunner: f.processes.processRunner,
      runtimeProcessRootScope: f.processes.runtimeProcessRootScope,
      processIdentity: { pid: 1, startedAt: '2026-10-26T00:00:00.000Z' },
      promptTemplates: createPromptTemplateRegistry(f.workflows),
      fatalPort: testApplicationFatalPort,
      freshness: NO_FRESHNESS_EFFECTS,
      runtimeStatusChanged: (status) => {
        if (status === 'stopped' && f.store.read('project')!.lifecycle.status === 'blocked')
          finish();
      },
      provider: scriptedAdmissionProvider(async (input, signal) => {
        captureComposition(`urgent-${target}-${turn + 1}`, input);
        expect(input.sessionId).toBe('agent:executor:project');
        turn++;
        if (turn === 1)
          return call('urgent-rebase', 'run_command', {
            command: `timeout -k 2s 20s bash -ec 'git rebase --merge --onto ${f.parentTip} ${f.base} || test -d .git/rebase-merge; printf "urgent partial\\n" > conflict.txt'`,
            wait: true,
          });
        if (turn === 2) {
          entered();
          return new Promise<never>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        expect(f.store.read('project')!.git!.correction!.preserved_source).not.toBeNull();
        return call('replacement-blocked', 'emit_result', {
          outcome: 'blocked',
          summary: 'Retain partial correction for later work.',
        });
      }),
    });
    try {
      await supervisor.startProject();
      await waiting;
      const result = await supervisor.submitNotification(
        child?.id ?? 'project',
        {
          id: randomUUID(),
          content: 'Reconsider correction scope.',
          created_at: new Date().toISOString(),
          source: 'fixture',
        },
        'urgent',
      );
      expect(result).toMatchObject({
        queued: true,
        interruption: {
          status: 'interrupted',
          stopped_card_ids: target === 'root' ? ['project'] : [],
        },
      });
      await stopped;
      expect(turn).toBe(3);
      const facts = f.store.read('project')!.git!;
      expect(git(f.root, 'show', `${facts.observed_tip}:conflict.txt`)).toBe('urgent partial');
      expect(git(f.root, 'show', `${facts.correction!.retained_original_ref}:c2.txt`)).toBe(
        'original c2',
      );
      expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      const finished = readCardExecutions(f.root, 'project').filter(
        (row) => row.kind === 'native_finished',
      );
      expect(finished.filter((row) => row.outcome === 'captured')).toHaveLength(1);
      expect(finished.filter((row) => row.outcome === 'returned')).toHaveLength(2);
    } finally {
      await supervisor.stopProject();
      await supervisor.cleanupForApplicationStop();
    }
  },
  180000,
);
import { materializeSystemTemplate, resolveSystemTemplate } from '../../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
