import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { CardService } from '../../src/cards/card-service.js';
import { createResolvedConfigAuthority } from '../../src/config/index.js';
import { join } from 'node:path';
import { quoteBashWord } from './bash-word.js';
import { qualityToolBindingsSchema } from '../../src/schemas/quality-operation-config.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';
import { readCardExecutions } from '../../src/persistence/card-execution-log.js';
import {
  appOrigin,
  closeServer,
  initializeProject,
  listen,
  offeredToolNames,
  postStartProject,
  productionTestConfig,
  readJsonRequest,
  sendFinalMessage,
  sendToolCall,
  startProductionApp,
  waitFor,
  writeProductionConfig,
} from './production-composition-e2e.js';

/** Existing production composition + local scripted provider, finite real commands only. */
export const executionReport = `\uFEFFACTUAL-ACTION-OUTPUT\r\n你好\r\n${'你好世界🌍🚀😀\r\n'.repeat(80)}api_key: stdout-record-private-canary\r\n`;
export async function executionProductionFixture(exitCode = 0, deadline = false, quality?: {
  language: 'javascript' | 'typescript' | 'python'; fixture: 'clean' | 'defect' | 'config-error';
  assessmentGate?: Promise<void>;
  reviewerGate?: Promise<void>;
  cardTool?: boolean;
  slowNative?: boolean;
  evidenceTag?: string;
}) {
  if (quality && !process.env.SAIVAGE_QUALITY_TEST_SCRATCH)
    throw new Error('Quality production fixture requires explicit SAIVAGE_QUALITY_TEST_SCRATCH.');
  const root = mkdtempSync(join(quality ? process.env.SAIVAGE_QUALITY_TEST_SCRATCH! : tmpdir(), 'executions-production-'));
  const token = 'disposable-executions-token';
  let analystStarted = false;
  let analystAction: 'start_project' | 'reopen_card' = 'start_project';
  let activationNumber = 0;
  let assessmentGate = quality?.assessmentGate;
  let workflowCalls = 0;
  let providerCalls = 0;
  let assessmentRequest: unknown = null;
  let cardToolRequested = false;
  let cardToolContinuation: unknown = null;
  let reviewerReadRequest: unknown = null;
  let reviewerStep = 0;
  const recentProviderRequests: string[] = [];
  const provider = createServer(async (request, response) => {
    const body = await readJsonRequest(request);
    providerCalls++;
    if (quality) {
      recentProviderRequests.push(redactTextForOutbound(JSON.stringify(body)).slice(0, 32768));
      if (recentProviderRequests.length > 4) recentProviderRequests.shift();
    }
    const evidence = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, quality
          ? `quality-${quality.evidenceTag ?? 'ordinary'}-${quality.language}-${quality.fixture}-${deadline ? 'timeout' : quality.slowNative ? 'cancel' : 'normal'}-activation-${activationNumber}-turn-${providerCalls}.json`
          : `execution-wire-exit-${exitCode}-turn-${providerCalls}.json`),
        JSON.stringify(body, null, 2),
      );
    }
    const tools = offeredToolNames(body);
    if (tools.includes('emit_result')) {
      if (quality?.cardTool && !cardToolRequested) {
        cardToolRequested = true;
        sendToolCall(response, 'card-quality', `code_quality_${quality.language}_${quality.language === 'python' ? 'ruff' : 'eslint'}`, {});
        return;
      }
      if (quality?.cardTool && workflowCalls === 0) cardToolContinuation = body;
      workflowCalls++;
      if (quality && workflowCalls >= 3 && quality.fixture !== 'config-error') {
        reviewerStep++;
        if (reviewerStep === 1) {
          // Deliberately premature: the ordinary updated review-record gate must
          // reject this result before the provider receives its correction.
          sendToolCall(response, 'review-premature', 'emit_result', { outcome: 'approved', summary: 'Premature fixture result: required review is not written.' });
        } else if (reviewerStep === 2) {
          sendToolCall(response, 'review-read', 'read', { path: `record:///check-report.md?card=project&v=${activationNumber}` });
        } else if (reviewerStep === 3) {
          reviewerReadRequest = body;
          await quality.reviewerGate;
          sendToolCall(response, 'review-write', 'write', { path: 'record:///review.md?card=project', content: `Deterministic fixture review of the scoped native evidence in record:///check-report.md?card=project&v=${activationNumber}. This approves only the evidence plumbing fixture, not software correctness or absence of defects.` });
        } else {
          sendToolCall(response, 'review-approved', 'emit_result', { outcome: 'approved', summary: 'Scoped evidence fixture reviewed after reading accepted native evidence and writing required review.' });
        }
        return;
      }
      if (quality && workflowCalls % 2 === 0) {
        assessmentRequest = body;
        await assessmentGate;
      }
      sendToolCall(response, `workflow-${workflowCalls}`, 'emit_result', {
        outcome: workflowCalls % 2 === 1 ? 'ready' : 'complete',
        summary:
          workflowCalls === 1 ? 'Prepared finite command.' : 'Assessed finite command evidence.',
      });
    } else if (tools.includes('start_project') && !analystStarted) {
      analystStarted = true;
      sendToolCall(response, `analyst-${analystAction}-${activationNumber}`, analystAction,
        analystAction === 'reopen_card' ? { cardId: 'project' } : {});
    } else sendFinalMessage(response, 'Finite fixture admitted.');
  });
  const port = await listen(provider);
  const config = productionTestConfig(port, (config) => {
    config.card_types.project!.records['check-report.md'] = { format: 'markdown', schema: 'check-report.v1', bootstrap: false };
    const workflow = config.card_types.project!.workflow;
    const original = workflow.nodes.plan!;
    if (original.execution.kind !== 'agent') throw new Error('Expected fixture Planner.');
    const agent = original.execution;
    workflow.entries.BACKLOG = { node: 'plan' };
    workflow.entries.CHANGED = { node: 'plan' };
    workflow.entries.BLOCKED = { node: 'plan' };
    workflow.entries.STOPPED = { ...workflow.entries.STOPPED, node: 'plan' };
    const complete = {
      target: { terminal: 'DONE' as const, promote: 'current' as const, export_records: [] },
    };
    const blocked = {
      target: { terminal: 'BLOCKED' as const, promote: 'current' as const, export_records: [] },
    };
    workflow.nodes = {
      plan: {
        execution: { ...agent, prompt: { reference: 'execution-prepare', compactable: true } },
        records: {},
        edges: { ready: { target: { node: 'check' } } },
      },
      check: {
        execution: {
          kind: 'action',
          action: 'shell.run',
          contract_version: 1,
          config: {
             // ASCII byte encoding prevents YAML folding from splitting Unicode surrogate pairs;
             // the real child writes the original UTF-8 bytes, including BOM and CRLF.
             script: `timeout --kill-after=1s 8s ${quoteBashWord(process.execPath)} -e ${quoteBashWord(`require('node:fs').writeFileSync('action-report.txt', 'mutable action report'); process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(executionReport, 'utf8').toString('base64'))}, 'base64')); process.stderr.write('DISTINCT-STDERR-ONLY\\n'); ${deadline ? 'setInterval(()=>{},1000)' : `process.exitCode=${exitCode}`}`)}`,
             timeout_ms: deadline ? 1000 : 3000,
            env: { CI: 'synthetic-env-not-public' },
            terminate_grace_ms: 100,
            artifacts: ['action-report.txt', 'absent-report.txt'],
          },
          inputs: { args: { literal: [] } },
        },
        output_record: 'check-report.md',
        records: { 'check-report.md': { mode: 'continue', gate: 'updated' } },
        edges: {
          passed: { target: { node: 'assess' } },
          failed: { target: { node: 'repair' } },
          signalled: blocked,
          timed_out: blocked,
        },
      },
      assess: {
        execution: { ...agent, prompt: { reference: 'execution-assess', compactable: true } },
        records: {},
        edges: { complete },
      },
      repair: {
        execution: { ...agent, prompt: { reference: 'execution-repair', compactable: true } },
        records: {},
        edges: { complete: blocked },
      },
    };
    workflow.after_activation_commit = {
      statuses: ['done', 'blocked'],
      execution: {
        kind: 'action',
        action: 'shell.run',
        contract_version: 1,
        config: {
           script: `timeout --kill-after=1s 8s ${quoteBashWord(process.execPath)} -e 'require("node:fs").writeFileSync("hook-report.txt", "mutable hook report"); console.log("ACTUAL-HOOK-OUTPUT")'`,
          timeout_ms: 3000,
          terminate_grace_ms: 100,
          artifacts: ['hook-report.txt'],
        },
        inputs: { args: { literal: [] } },
      },
    };
    if (quality) {
      const toolsRoot = process.env.SAIVAGE_QUALITY_NATIVE_ROOT;
      if (!toolsRoot) throw new Error('Quality production fixture requires provisioned SAIVAGE_QUALITY_NATIVE_ROOT.');
      const language = quality.language;
      const extension = language === 'javascript' ? 'js' : language === 'typescript' ? 'ts' : 'py';
      const nativeConfig = {
          cwd: 'fixtures', source_paths: [`fixtures/${quality.fixture === 'clean' ? 'clean' : 'defect'}.${extension}`],
          exclusions: [], timeout_ms: deadline ? 3000 : 30000, terminate_grace_ms: 100,
          native_config: quality.slowNative ? 'fixtures/slow.mjs' : `fixtures/${quality.fixture === 'config-error' ? 'bad-' : ''}${language === 'python' ? 'ruff.toml' : 'eslint.config.mjs'}`,
          ...(language === 'python' ? { ruff_binary: join(toolsRoot, 'venv/bin/ruff') }
            : { node_binary: process.execPath, eslint_module: 'node_modules/eslint' }),
          ...(language === 'typescript' ? { tsconfig: 'fixtures/tsconfig.json',
            typescript_eslint_module: 'node_modules/typescript-eslint', typescript_module: 'node_modules/typescript' } : {}),
      };
      workflow.nodes.check!.execution = {
        kind: 'action', action: `code-quality.${language}.${language === 'python' ? 'ruff' : 'eslint'}`,
        contract_version: 1, inputs: {}, config: nativeConfig,
      };
      workflow.nodes.check!.edges = {
        clean: { target: { node: 'assess' } }, findings: { target: { node: 'assess' } },
        analysis_failed: { target: { node: 'repair' } }, timed_out: blocked, signalled: blocked,
      };
      if (quality.cardTool) {
        const toolName = `code_quality_${language}_${language === 'python' ? 'ruff' : 'eslint'}`;
        const owner = config.agents[agent.agent]!;
        owner.tools.push(toolName);
        owner.quality_tools = qualityToolBindingsSchema.parse({ format_version: 1,
          [toolName]: { ...nativeConfig,
            source_paths: [`fixtures/clean.${extension}`] },
        });
      }
      workflow.nodes.assess!.edges = { complete: { target: { node: 'review' } } };
      workflow.nodes.review = {
        execution: { ...agent, agent: 'reviewer', prompt: { reference: 'execution-review', compactable: true },
          correction_prompt: { reference: 'correct-review-result', compactable: true } },
        records: { 'review.md': { mode: 'clean', gate: 'updated' } },
        edges: { approved: {
          ...complete,
          pending_notifications: {
            node: 'plan',
            prompt: { reference: 'review-to-notifications', compactable: true },
          },
        } },
      };
      delete workflow.after_activation_commit;
    }
  });
  if (quality) {
    const toolsRoot = process.env.SAIVAGE_QUALITY_NATIVE_ROOT!;
    cpSync(join(toolsRoot, 'node_modules'), join(root, 'node_modules'), { recursive: true });
    cpSync(join(toolsRoot, 'fixtures'), join(root, 'fixtures'), { recursive: true });
    // Actual native-config failure, not a fake helper response.
    writeFileSync(join(root, 'fixtures/bad-eslint.config.mjs'), 'throw new Error("synthetic native configuration failure");\n');
    if (quality.slowNative) writeFileSync(join(root, 'fixtures/slow.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync(new URL('./native-entered',import.meta.url),'entered');
setInterval(()=>{},1000); await new Promise(()=>{}); export default [];\n`);
  }
  writeProductionConfig(root, config);
  const prompts = join(root, '.saivage', 'config', 'prompts', 'process', 'project');
  mkdirSync(prompts, { recursive: true });
  for (const [name, text] of Object.entries({
    'execution-prepare':
      'Admit the configured finite local check. No command has run yet; return the generated ready outcome to enter the action node, without claiming execution or acceptance.',
    'execution-assess':
      'Assess the quoted action observation and its exact execution evidence. Complete this finite fixture only on the known successful check; do not infer broader project acceptance or replay the command.',
    'execution-repair':
      'The finite check did not pass. Preserve its observed failure and evidence; return this fixture to BLOCKED through the generated completion outcome, without repair, retry or a success claim.',
    'execution-review':
      'Review only this evidence-plumbing fixture. Read the accepted check-report.md at its immutable version, distinguish scoped clean/findings from product acceptance, and write review.md before returning approved. A native finding is not itself a failed evidence-plumbing check; do not claim software correctness.',
  })) {
    writeFileSync(join(prompts, `${name}.md`), text);
  }
  initializeProject(root);
  const app = await startProductionApp(root, token);
  const origin = appOrigin(app);
  const authority = createResolvedConfigAuthority({
    projectRoot: root,
    path: join(root, '.saivage', 'saivage.yaml'),
    interpolationEnvironment: {},
  });
  const cards = new CardService(root, authority.loadEffective().workflows);
  return {
    root,
    token,
    app,
    origin,
    cards,
    counts: () => ({ workflowCalls, providerCalls }),
    assessmentRequest: () => assessmentRequest,
    cardToolContinuation: () => cardToolContinuation,
    reviewerReadRequest: () => reviewerReadRequest,
    captureFailure(error: unknown) {
      const diagnostic = {
        root, quality: quality ? { language: quality.language, fixture: quality.fixture } : null,
        error: redactTextForOutbound(error instanceof Error ? error.message : String(error)).slice(0, 2000),
        workflowCalls, providerCalls, reviewerStep, cardToolRequested,
        assessmentReached: assessmentRequest !== null,
        reviewerReadReached: reviewerReadRequest !== null,
        runtime: app.server.runtimeApplication.runtimeApi.getStatus(),
        card: cards.read('project'),
        executions: readCardExecutions(root, 'project').slice(-8),
        recentProviderRequests,
        limits: 'Last four provider requests, redacted then capped at 32768 characters each; last eight execution rows. Full owning history remains in preserved test root.',
      };
      writeFileSync(join(root, 'quality-failure-diagnostic.json'), redactTextForOutbound(JSON.stringify(diagnostic, null, 2)));
      console.error(`Quality fixture failed; retained evidence: ${join(root, 'quality-failure-diagnostic.json')}`);
    },
    async reopen() {
      analystStarted = false;
      analystAction = 'reopen_card';
      const response = await fetch(`${origin}/api/chat`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Reopen the completed project for another scoped evidence-fixture activation. Do not start it yet.' }),
      });
      const body = await response.json();
      if (response.status !== 200 || cards.read('project')!.lifecycle.status !== 'changed')
        throw new Error(`Fixture reopen did not reach CHANGED: HTTP ${response.status}; ${JSON.stringify(body).slice(0, 2000)}`);
    },
    async run(nextAssessmentGate?: Promise<void>) {
      analystStarted = false;
      analystAction = 'start_project';
      activationNumber++;
      workflowCalls = 0;
      reviewerStep = 0;
      cardToolRequested = false;
      cardToolContinuation = null;
      assessmentRequest = null;
      reviewerReadRequest = null;
      assessmentGate = nextAssessmentGate ?? quality?.assessmentGate;
      const result = await postStartProject(origin, token);
      if (result.status !== 200) throw new Error(`Fixture admission failed: ${result.status}`);
      await waitFor(
        () => ['done', 'blocked'].includes(cards.read('project')!.lifecycle.status),
        'finite action and assessment',
      );
      // Natural settlement owns the hook and parent/root release, not just the card commit.
      await waitFor(
        () => app.server.runtimeApplication.runtimeApi.getStatus().status === 'stopped',
        'hook settlement and root release',
      );
    },
    async close(preserve = false) {
      await app.stop();
      await closeServer(provider);
      if (!preserve) rmSync(root, { recursive: true, force: true });
    },
  };
}
