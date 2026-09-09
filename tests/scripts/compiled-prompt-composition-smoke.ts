#!/usr/bin/env node
//
// Compiled per-template prompt-composition smoke.
//
// Compile this smoke alongside production modules, then execute the emitted
// JavaScript with exactly `--source-root <repository>`. Module and packaged
// prompt roots derive from the emitted smoke location; source-root is used only
// for source prompt byte comparisons.
//
// Per registered template, the compiled registry's module-relative prompt root
// must resolve inside its own packaged tree under
// dist/src/config/system-templates/<name>/prompts/, that tree must equal the
// source tree file-for-file and byte-for-byte, and compiling the template's
// behavior must resolve no artifact outside its own root.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 4 || process.argv[2] !== '--source-root' || process.argv[3]!.length === 0) throw new Error('Usage: compiled-prompt-composition-smoke.js --source-root <path>');
const repositoryRoot = resolve(process.argv[3]!);
const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const walk = (root: string, current: string = root): string[] => readdirSync(current, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(root, join(current, entry.name)) : [join(current, entry.name).slice(root.length + 1)]).sort();

const { effectiveSaivageConfigSchema } = await import('../../src/schemas/saivage-config.js');
const { DEFAULT_SAIVAGE_CONFIG, SYSTEM_TEMPLATES, resolveSystemTemplate } = await import('../../src/config/system-templates/registry.js');
const { compileProjectWorkflows, bindRuntimeWorkflows } = await import('../../src/runtime/card-process/card-process-config.js');
const { ProviderRegistry } = await import('../../src/agents/provider.js');
const { ModelRouter } = await import('../../src/agents/model-router.js');
const { createRuntimeApplication } = await import('../../src/application/runtime-composition.js');
const { NO_FRESHNESS_EFFECTS } = await import('../../src/application/freshness-effects.js');
const { CardService } = await import('../../src/cards/card-service.js');
const { createResolvedConfigAuthority } = await import('../../src/config/index.js');
const { createEventLog } = await import('../../src/observability/index.js');
const { ManagedProcessGroupRegistry } = await import('../../src/runtime/managed-process-group-registry.js');
const { ProcessRunner } = await import('../../src/runtime/process-runner.js');
const { renderCompiledPrompt } = await import('../../src/utils/prompt-api.js');
const { createApplicationFatalPort } = await import('../../src/contracts/index.js');
const { globalAgentSessionId } = await import('../../src/schemas/conversation-session-id.js');

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

for (const template of SYSTEM_TEMPLATES) {
  const packagedRoot = join(distRoot, 'src', 'config', 'system-templates', template.name, 'prompts');
  if (resolve(template.promptRoot) !== resolve(packagedRoot)) {
    throw new Error(`Template '${template.name}' must resolve its prompt root at its own packaged tree: ${template.promptRoot}`);
  }
  if (!existsSync(packagedRoot) || !statSync(packagedRoot).isDirectory()) {
    throw new Error(`Compiled prompt smoke requires the packaged prompt tree for '${template.name}' at ${packagedRoot}`);
  }
  const sourceRoot = join(repositoryRoot, 'src', 'config', 'system-templates', template.name, 'prompts');
  const packagedFiles = walk(packagedRoot);
  if (JSON.stringify(packagedFiles) !== JSON.stringify(walk(sourceRoot))) throw new Error(`Packaged prompt tree for '${template.name}' must equal its source tree file-for-file.`);
  for (const file of packagedFiles) {
    if (readFileSync(join(packagedRoot, file), 'utf8') !== readFileSync(join(sourceRoot, file), 'utf8')) throw new Error(`Packaged prompt artifact differs from source for '${template.name}': ${file}`);
  }
}

const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-compiled-prompt-composition-'));
const observeInside = (templateName: string, packagedRoot: string) => (artifact: { path: string }) => {
  const packaged = resolve(packagedRoot);
  const artifactPath = resolve(artifact.path);
  if (artifactPath !== packaged && !artifactPath.startsWith(`${packaged}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Template '${templateName}' resolved an artifact outside its own packaged root: ${artifact.path}`);
  }
};
let application: ReturnType<typeof createRuntimeApplication> | undefined;

try {
  const classic = resolveSystemTemplate('classic');
  const classicTyped = resolveSystemTemplate('classic-typed');
  const baseConfig = effectiveSaivageConfigSchema.parse({
    ...structuredClone(DEFAULT_SAIVAGE_CONFIG),
    models: {
      ...structuredClone(DEFAULT_SAIVAGE_CONFIG.models),
      routes: Object.fromEntries(Object.keys(DEFAULT_SAIVAGE_CONFIG.models.routes).map((name) => [name, { candidates: ['test-model'], temperature: 0, max_tokens: 200 }])),
    },
    providers: {
      test: {
        models: ['test-model'],
        capabilities: {
          contextWindowTokens: 100_000,
          maxOutputTokens: 10_000,
        },
      },
    },
    compaction: {
      ...structuredClone(DEFAULT_SAIVAGE_CONFIG.compaction),
      enabled: true,
      input_budget_tokens: 10_000,
      summarizer_candidate: { provider: 'test', account: null, model: 'test-model' },
    },
  });
  const { card_types: _defaultCardTypes, ...globals } = structuredClone(baseConfig);
  const classicTestConfig = effectiveSaivageConfigSchema.parse({ ...structuredClone(globals), card_types: structuredClone(classic.config.card_types) });
  const typedTestConfig = effectiveSaivageConfigSchema.parse({ ...structuredClone(globals), card_types: structuredClone(classicTyped.config.card_types) });
  const classicWorkflows = compileProjectWorkflows(classicTestConfig, { projectRoot, artifactObserver: observeInside('classic', classic.promptRoot) });
  const typedWorkflows = compileProjectWorkflows(typedTestConfig, { defaultPromptRoot: classicTyped.promptRoot, projectRoot, artifactObserver: observeInside('classic-typed', classicTyped.promptRoot) });
  const derivedDefaultWorkflows = compileProjectWorkflows(structuredClone(DEFAULT_SAIVAGE_CONFIG), { projectRoot, artifactObserver: observeInside('classic', classic.promptRoot) });
  const renderAgentPrompts = (workflows: ReturnType<typeof compileProjectWorkflows>) => [...workflows.cardTypes].flatMap(([cardType, workflow]) => [...workflow.states.values()].filter((state) => state.kind === 'node').map((state) => state.kind === 'node' ? renderCompiledPrompt({ kind: 'workflow-agent', cardType }, state.agent.name, state.selectedAgentPrompt.compiled, { contractDescription: 'contract' }) : ''));
  if (JSON.stringify(renderAgentPrompts(classicWorkflows)) !== JSON.stringify(renderAgentPrompts(derivedDefaultWorkflows))) throw new Error('Derived default rendered prompt baseline changed.');
  const analystText = renderCompiledPrompt({ kind: 'global-agent' }, typedWorkflows.analyst.name, typedWorkflows.analystPrompt.compiled, { vocabularySnippet: 'vocabulary' });
  if (analystText.includes('{{')) throw new Error('Unresolved Analyst template syntax.');
  for (const [cardType, workflow] of typedWorkflows.cardTypes) for (const prompt of workflow.processPrompts.values()) {
    if (prompt.text.includes('{{')) throw new Error(`Unresolved process template syntax for ${cardType}/${prompt.reference}`);
    if ((prompt.reference === 'execute' || prompt.reference === 'plan') && !prompt.text.includes(cardType)) throw new Error(`Missing eager cardType rendering for ${cardType}/${prompt.reference}`);
  }
  for (const [cardType, workflow] of typedWorkflows.cardTypes) for (const state of workflow.states.values()) if (state.kind === 'node') {
    const text = renderCompiledPrompt({ kind: 'workflow-agent', cardType }, state.agent.name, state.selectedAgentPrompt.compiled, { contractDescription: 'contract' });
    if (text.includes('{{')) throw new Error(`Unresolved agent template syntax for ${cardType}/${state.agent.name}`);
  }
  const goal = requireValue(typedWorkflows.cardTypes.get('goal'), 'Missing typed goal workflow.');
  const classicGoal = requireValue(classicWorkflows.cardTypes.get('goal'), 'Missing classic goal workflow.');
  const plan = requireValue(goal.states.get('node:plan'), 'Missing typed planning node.');
  const classicPlan = requireValue(classicGoal.states.get('node:plan'), 'Missing classic planning node.');
  if (plan.kind !== 'node' || classicPlan.kind !== 'node') throw new Error('Missing planning nodes.');
  const planText = requireValue(goal.processPrompts.get(plan.promptId), 'Missing typed planning prompt.').text;
  for (const required of ['Inspect all direct children', 'BACKLOG, CHANGED, BLOCKED, or STOPPED', '`title`, `tags`, `priority`, `urgency`, or `related`', 'Planner has no `reopen_card` tool', 'reopen_card({cardId:"<id>"})', 'stopped or settled paused', 'independently reviewable or parallelizable']) if (!planText.includes(required)) throw new Error(`Typed Planner composition lacks '${required}'.`);
  const classicPlanText = requireValue(classicGoal.processPrompts.get(classicPlan.promptId), 'Missing classic planning prompt.').text;
  if (classicPlanText.includes('Planner has no `reopen_card` tool') || classicPlanText.includes('reopen_card({cardId:"<id>"})')) throw new Error('Typed planning guidance leaked into the classic template.');
  const architecture = requireValue(typedWorkflows.cardTypes.get('architecture'), 'Missing architecture workflow.');
  for (const nodeId of ['component-review', 'system-review']) {
    const node = requireValue(architecture.states.get(`node:${nodeId}`), `Missing ${nodeId}.`);
    if (node.kind !== 'node') throw new Error(`Missing ${nodeId}.`);
    const agent = renderCompiledPrompt({ kind: 'workflow-agent', cardType: 'architecture' }, node.agent.name, node.selectedAgentPrompt.compiled, { contractDescription: 'contract' });
    if (node.selectedAgentPrompt.source !== 'bundled-shared' || !agent.includes('record:///review.md?card=<card-id>') || !requireValue(architecture.processPrompts.get(node.promptId), `Missing ${nodeId} prompt.`).text.includes('record:///review.md?card=<card-id>')) throw new Error(`${nodeId} does not compose the shared Reviewer with current review.md.`);
  }
  for (const prompt of architecture.processPrompts.values()) if (prompt.reference.includes('revision') || prompt.reference === 'architecture-to-system-review') {
    if (!prompt.text.includes('versioned `review.md` URL')) throw new Error(`${prompt.reference} lacks immutable transition evidence guidance.`);
  }
  const providerRegistry = new ProviderRegistry(typedTestConfig);
  const workflows = bindRuntimeWorkflows(typedWorkflows, new ModelRouter(providerRegistry));
  const configAuthority = createResolvedConfigAuthority({
    path: join(projectRoot, '.saivage', 'saivage.yaml'),
    interpolationEnvironment: process.env,
  });
  const processRegistry = new ManagedProcessGroupRegistry();
  const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime-cards');
  const analystProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'analyst-sessions');
  const fatalPort = createApplicationFatalPort();
  createEventLog(projectRoot);
  const processRunner = new ProcessRunner(projectRoot, processRegistry, fatalPort);
  const mcpToolInvocation = {
    getServerTools() { throw new Error('Unexpected MCP server tools read in compiled prompt smoke.'); },
    findToolCapability() { throw new Error('Unexpected MCP capability read in compiled prompt smoke.'); },
    invokeTool() { return Promise.reject(new Error('Unexpected MCP invocation in compiled prompt smoke.')); },
  };

  application = createRuntimeApplication({
    projectRoot,
    processIdentity: { pid: process.pid, startedAt: new Date().toISOString() },
    config: typedTestConfig,
    configAuthority,
    workflows,
    providerRegistry,
    cardStore: new CardService(projectRoot, workflows, NO_FRESHNESS_EFFECTS),
    restartCapability: { available: false },
    freshness: NO_FRESHNESS_EFFECTS,
    processRunner,
    runtimeProcessRootScope,
    analystProcessRootScope,
    mcpToolInvocation,
    fatalPort,
    analystSessionId: globalAgentSessionId(workflows.analyst.name),
  });
} finally {
  try {
    if (application) {
      application.closeRuntimeAdmission();
      application.processRunner.closeLaunchAdmission();
      application.closeAnalystAdmission();
      await Promise.all([
        application.cleanupRuntimeForApplicationStop(),
        application.cleanupAnalystForApplicationStop(),
      ]);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

console.log(`Compiled production composition loaded per-template packaged prompts for ${SYSTEM_TEMPLATES.map((template) => template.name).join(' and ')}.`);
