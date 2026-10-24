import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createAnalystOperationSurface } from '../../src/application/analyst-operation-surface.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { invokeTool } from '../../src/tools/invocation.js';
import { CardService } from '../../src/cards/card-service.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { qualityToolBindingsSchema, type QualityToolName } from '../../src/schemas/quality-operation-config.js';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { compileActionExecution } from '../../src/runtime/card-process/operation-routing.js';
import { invokeOperation } from '../../src/runtime/actors/operation-execution.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { readCardExecutions } from '../../src/persistence/card-execution-log.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

// Run the built script: its action owner resolves the actual packaged helper.js.
const tools = process.env.SAIVAGE_QUALITY_NATIVE_ROOT;
const scratch = process.env.SAIVAGE_QUALITY_TEST_SCRATCH;
if (!tools || !scratch) throw new Error('Set explicit provisioned SAIVAGE_QUALITY_NATIVE_ROOT and workspace SAIVAGE_QUALITY_TEST_SCRATCH.');
const root = mkdtempSync(join(resolve(scratch), 'quality-actions-'));
let fatal = false;
const registry = new ManagedProcessGroupRegistry();
const runner = new ProcessRunner(root, registry, { publicationOutcomeUnknown(error): never { fatal = true; throw error; } });
try {
  cpSync(join(tools, 'node_modules'), join(root, 'node_modules'), { recursive: true });
  cpSync(join(tools, 'fixtures'), join(root, 'fixtures'), { recursive: true });
  mkdirSync(join(root, '.saivage/cards/project/records'), { recursive: true });
  const workflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
  for (const [language, suffix, filename] of [
    ['javascript', 'eslint', 'defect.js'], ['typescript', 'eslint', 'defect.ts'], ['python', 'ruff', 'defect.py'],
  ] as const) {
    const config = { cwd: 'fixtures', native_config: `fixtures/${language === 'python' ? 'ruff.toml' : 'eslint.config.mjs'}`,
      source_paths: [`fixtures/${filename}`], exclusions: [], timeout_ms: 30000, terminate_grace_ms: 100,
      ...(language === 'python' ? { ruff_binary: join(resolve(tools), 'venv/bin/ruff') }
        : { node_binary: process.execPath, eslint_module: 'node_modules/eslint' }),
      ...(language === 'typescript' ? { tsconfig: 'fixtures/tsconfig.json',
        typescript_eslint_module: 'node_modules/typescript-eslint', typescript_module: 'node_modules/typescript' } : {}),
    };
    const before = readFileSync(join(root, 'fixtures', filename));
    const execution = compileActionExecution({ action: `code-quality.${language}.${suffix}`, contract_version: 1, config, inputs: {} }, workflows.operations, 'node');
    const result = await invokeOperation({ projectRoot: root, cardId: 'project', execution, inputs: {}, collectOutput: true,
      binding: { kind: 'node', activation_id: randomUUID(), node_id: 'quality', ordinal: 0 },
      processRunner: runner, runtimeProcessRootScope: registry.rootScope, signal: new AbortController().signal,
      retainSettlementFailure(error) { throw error; },
    });
    assert.equal(result.result.outcome, 'findings');
    assert.equal(result.result.values.coverage_complete, true);
    assert.equal(result.completedOutput?.descriptor.source, 'returned-text');
    assert.match(result.completedOutput!.content, /not product acceptance/i);
    assert(result.completedOutput!.processId);
    assert.deepEqual(readFileSync(join(root, 'fixtures', filename)), before);
    const rows = readCardExecutions(root, 'project');
    const finish = rows.at(-1)!;
    assert.equal(finish.kind, 'invocation_finished');
    if (finish.kind !== 'invocation_finished') throw new Error('Expected finish.');
    assert.equal(finish.files.filter((file) => file.kind === 'artifact').length, 5);
    assert.deepEqual(finish.absent_artifacts, []);
    assert.equal(finish.output?.source, 'returned-text');
    const toolName = `code_quality_${language}_${suffix}` as QualityToolName;
    const toolConfig = structuredClone(TEST_SAIVAGE_CONFIG);
    toolConfig.agents[toolConfig.analyst_agent]!.tools.push(toolName);
    toolConfig.agents[toolConfig.analyst_agent]!.quality_tools = qualityToolBindingsSchema.parse({ format_version: 1, [toolName]: config });
    const otherAgent = Object.values(toolConfig.agents).find((agent) => agent.session === 'card')!;
    otherAgent.tools.push(toolName);
    otherAgent.quality_tools = qualityToolBindingsSchema.parse({ format_version: 1,
      [toolName]: { ...config, source_paths: ['never-select-this-other-agent-scope'] } });
    const toolWorkflows = compileProjectWorkflows(toolConfig);
    // Unused mutation/control services deliberately have no implementation. This
    // actual selected surface must use only Analyst policy and the finite owner.
    const context = { projectRoot: root, store: new CardService(root, toolWorkflows),
      processRunner: runner, processScope: registry.rootScope, qualityProcessParentScope: registry.rootScope, sessionId: 'quality-native-smoke',
      runtime: {},
    } as unknown as Omit<ToolContext, 'actor' | 'surface' | 'policyAgentName' | 'analystMutations'>;
    const surface = createAnalystOperationSurface({ workflows: toolWorkflows,
      author: { kind: 'external-agent', principal: 'quality-native-smoke' }, allowedTools: [toolName], context,
      submitNotification: async () => { throw new Error('Unexpected notification'); },
      cancelCard: async () => { throw new Error('Unexpected cancellation'); }, currentProcessPosition: () => null,
    });
    assert.deepEqual([...surface.tools.keys()], [toolName]);
    const toolSettlement = await invokeTool(surface, toolName, {}, { kind: 'external',
      invocationId: randomUUID(), principal: 'quality-native-smoke', signal: new AbortController().signal });
    assert.equal(toolSettlement.kind, 'executed');
    if (toolSettlement.kind !== 'executed') throw new Error('Quality tool was not executed.');
    const projected = settleToolActionOutcome(toolSettlement.execution.providerOutcome).providerResult;
    assert.equal(projected.success, true, JSON.stringify(projected));
    const toolResult = projected.data as import('../../src/contracts/quality-tools.js').QualityToolResult;
    assert.equal(toolResult.operation, execution.operation.id);
    assert.equal(toolResult.outcome, result.result.outcome);
    assert.deepEqual(toolResult.values, result.result.values);
    assert.equal(toolResult.artifacts.length, 5);
    assert(toolResult.artifacts.every((artifact) => artifact.path.startsWith('work:///quality/')));
    assert.equal(readCardExecutions(root, 'project').length, rows.length, 'global tool must not append card execution history');
    assert.deepEqual(readFileSync(join(root, 'fixtures', filename)), before);
  }
  writeFileSync(join(root, 'fixtures/unsupported.txt'), 'This is not JavaScript.');
  for (const selection of [
    { source_paths: ['fixtures/missing.js'], exclusions: [], expected: 'analysis_failed' },
    { source_paths: ['fixtures/unsupported.txt'], exclusions: [], expected: 'analysis_failed' },
    { source_paths: ['fixtures/clean.js'], exclusions: ['fixtures/clean.js'], expected: 'analysis_failed' },
    { source_paths: ['fixtures/clean.js', 'fixtures/defect.js'], exclusions: ['fixtures/defect.js'], expected: 'clean' },
  ]) {
    const execution = compileActionExecution({ action: 'code-quality.javascript.eslint', contract_version: 1,
      inputs: {}, config: { cwd: 'fixtures', native_config: 'fixtures/eslint.config.mjs',
        node_binary: process.execPath, eslint_module: 'node_modules/eslint', timeout_ms: 30000, terminate_grace_ms: 100,
        source_paths: selection.source_paths, exclusions: selection.exclusions },
    }, workflows.operations, 'node');
    const selected = await invokeOperation({ projectRoot: root, cardId: 'project', execution, inputs: {}, collectOutput: true,
      binding: { kind: 'node', activation_id: randomUUID(), node_id: 'scope-check', ordinal: 0 },
      processRunner: runner, runtimeProcessRootScope: registry.rootScope, signal: new AbortController().signal,
      retainSettlementFailure(error) { throw error; },
    });
    assert.equal(selected.result.outcome, selection.expected);
    assert.equal(selected.result.values.coverage_complete, selection.expected === 'clean');
  }
  console.log('Three compiled quality actions and external tools plus missing/unsupported/excluded scope cases passed actual native execution.');
} finally {
  if (!fatal) {
    await runner.terminateScopeTree({ rootScope: registry.rootScope, categories: ['runtime_card'], reason: 'quality smoke cleanup', graceMs: 100 });
    rmSync(root, { recursive: true, force: true });
  }
}
