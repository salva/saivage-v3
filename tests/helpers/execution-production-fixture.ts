import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { CardService } from '../../src/cards/card-service.js';
import { createResolvedConfigAuthority } from '../../src/config/index.js';
import { join } from 'node:path';
import { quoteBashWord } from './bash-word.js';
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
export async function executionProductionFixture(exitCode = 0, deadline = false) {
  const root = mkdtempSync(join(tmpdir(), 'executions-production-'));
  const token = 'disposable-executions-token';
  let analystStarted = false;
  let workflowCalls = 0;
  let providerCalls = 0;
  const provider = createServer(async (request, response) => {
    const body = await readJsonRequest(request);
    providerCalls++;
    const evidence = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, `execution-wire-exit-${exitCode}-turn-${providerCalls}.json`),
        JSON.stringify(body, null, 2),
      );
    }
    const tools = offeredToolNames(body);
    if (tools.includes('emit_result')) {
      workflowCalls++;
      sendToolCall(response, `workflow-${workflowCalls}`, 'emit_result', {
        outcome: workflowCalls % 2 === 1 ? 'ready' : 'complete',
        summary:
          workflowCalls === 1 ? 'Prepared finite command.' : 'Assessed finite command evidence.',
      });
    } else if (tools.includes('start_project') && !analystStarted) {
      analystStarted = true;
      sendToolCall(response, 'start-project', 'start_project', {});
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
  });
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
    async run() {
      analystStarted = false;
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
    async close() {
      await app.stop();
      await closeServer(provider);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
