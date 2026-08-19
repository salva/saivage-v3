#!/usr/bin/env node
//
// Compiled per-template prompt-composition smoke.
//
// EXECUTION IS DEFERRED TO THE OWNER-AUTHORIZED BUILD WINDOW: this smoke imports
// compiled modules and packaged prompt trees from `dist/`, which is written by
// `npm run build` and is live-executed by bind-mounted services (see
// docs/working/2026-08-19-init-templates/design-plan.md §7.4). It is invoked by
// the build chain and `npm run test:compiled-prompt-composition` only.
//
// Per registered template, the compiled registry's module-relative prompt root
// must resolve inside its own packaged tree under
// dist/src/config/system-templates/<name>/prompts/, that tree must equal the
// source tree file-for-file and byte-for-byte, and compiling the template's
// behavior must resolve no artifact outside its own root.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distRoot = join(repositoryRoot, 'dist');
const compiledRoot = join(distRoot, 'src');

const walk = (root, current = root) => readdirSync(current, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(root, join(current, entry.name)) : [join(current, entry.name).slice(root.length + 1)]).sort();

function compiledModule(relativePath) {
  return pathToFileURL(join(compiledRoot, relativePath)).href;
}

const [
  { saivageConfigSchema },
  { DEFAULT_SAIVAGE_CONFIG, SYSTEM_TEMPLATES, resolveSystemTemplate },
  { compileProjectWorkflows, bindRuntimeWorkflows },
  { ProviderRegistry },
  { ModelRouter },
  { createRuntimeApplication },
  { NO_FRESHNESS_EFFECTS },
  { CardService },
  { createResolvedConfigAuthority },
  { createEventLog },
  { ManagedProcessGroupRegistry },
  { ProcessRunner },
  { renderCompiledPrompt },
  { createApplicationFatalPort },
  { globalAgentSessionId },
] = await Promise.all([
  import(compiledModule('schemas/saivage-config.js')),
  import(compiledModule('config/system-templates/registry.js')),
  import(compiledModule('runtime/card-process/card-process-config.js')),
  import(compiledModule('agents/provider.js')),
  import(compiledModule('agents/model-router.js')),
  import(compiledModule('application/runtime-composition.js')),
  import(compiledModule('application/freshness-effects.js')),
  import(compiledModule('cards/card-service.js')),
  import(compiledModule('config/index.js')),
  import(compiledModule('observability/index.js')),
  import(compiledModule('runtime/managed-process-group-registry.js')),
  import(compiledModule('runtime/process-runner.js')),
  import(compiledModule('utils/prompt-api.js')),
  import(compiledModule('contracts/index.js')),
  import(compiledModule('schemas/conversation-session-id.js')),
]);

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
const observeInside = (templateName, packagedRoot) => (artifact) => {
  const packaged = resolve(packagedRoot);
  const artifactPath = resolve(artifact.path);
  if (artifactPath !== packaged && !artifactPath.startsWith(`${packaged}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Template '${templateName}' resolved an artifact outside its own packaged root: ${artifact.path}`);
  }
};
let application;

try {
  const classic = resolveSystemTemplate('classic');
  const classicTyped = resolveSystemTemplate('classic-typed');
  const baseConfig = saivageConfigSchema.parse({
    ...structuredClone(DEFAULT_SAIVAGE_CONFIG),
    models: {
      ...structuredClone(DEFAULT_SAIVAGE_CONFIG.models),
      routes: Object.fromEntries(Object.keys(DEFAULT_SAIVAGE_CONFIG.models.routes).map((name) => [name, { candidates: ['test-model'], temperature: 0, max_tokens: 200 }])),
    },
    providers: { test: { models: ['test-model'] } },
    compaction: {
      enabled: true,
      input_budget_tokens: 1000,
      summarizer_candidate: { provider: 'test', account: null, model: 'test-model' },
    },
  });
  const { card_types: _defaultCardTypes, ...globals } = structuredClone(baseConfig);
  const classicTestConfig = saivageConfigSchema.parse({ ...structuredClone(globals), card_types: structuredClone(classic.config.card_types) });
  const typedTestConfig = saivageConfigSchema.parse({ ...structuredClone(globals), card_types: structuredClone(classicTyped.config.card_types) });
  const classicWorkflows = compileProjectWorkflows(classicTestConfig, { projectRoot, artifactObserver: observeInside('classic', classic.promptRoot) });
  const typedWorkflows = compileProjectWorkflows(typedTestConfig, { defaultPromptRoot: classicTyped.promptRoot, projectRoot, artifactObserver: observeInside('classic-typed', classicTyped.promptRoot) });
  const derivedDefaultWorkflows = compileProjectWorkflows(structuredClone(DEFAULT_SAIVAGE_CONFIG), { projectRoot, artifactObserver: observeInside('classic', classic.promptRoot) });
  const renderAgentPrompts = (workflows) => [...workflows.cardTypes].flatMap(([cardType, workflow]) => [...workflow.states.values()].filter((state) => state.kind === 'node').map((state) => renderCompiledPrompt(cardType, state.agent.name, state.selectedAgentPrompt.compiled, { contractDescription: 'contract' })));
  if (JSON.stringify(renderAgentPrompts(classicWorkflows)) !== JSON.stringify(renderAgentPrompts(derivedDefaultWorkflows))) throw new Error('Derived default rendered prompt baseline changed.');
  const analystText = renderCompiledPrompt('global', typedWorkflows.analyst.name, typedWorkflows.analystPrompt.compiled, { vocabularySnippet: 'vocabulary' });
  if (analystText.includes('{{')) throw new Error('Unresolved Analyst template syntax.');
  for (const [cardType, workflow] of typedWorkflows.cardTypes) for (const prompt of workflow.processPrompts.values()) {
    if (prompt.text.includes('{{')) throw new Error(`Unresolved process template syntax for ${cardType}/${prompt.reference}`);
    if ((prompt.reference === 'execute' || prompt.reference === 'plan') && !prompt.text.includes(cardType)) throw new Error(`Missing eager cardType rendering for ${cardType}/${prompt.reference}`);
  }
  for (const [cardType, workflow] of typedWorkflows.cardTypes) for (const state of workflow.states.values()) if (state.kind === 'node') {
    const text = renderCompiledPrompt(cardType, state.agent.name, state.selectedAgentPrompt.compiled, { contractDescription: 'contract' });
    if (text.includes('{{')) throw new Error(`Unresolved agent template syntax for ${cardType}/${state.agent.name}`);
  }
  const plan = typedWorkflows.cardTypes.get('goal').states.get('node:plan');
  const classicPlan = classicWorkflows.cardTypes.get('goal').states.get('node:plan');
  if (plan.kind !== 'node' || classicPlan.kind !== 'node') throw new Error('Missing planning nodes.');
  const planText = typedWorkflows.cardTypes.get('goal').processPrompts.get(plan.promptId).text;
  for (const required of ['Inspect all direct children', 'BACKLOG, CHANGED, BLOCKED, or STOPPED', '`title`, `tags`, `priority`, `urgency`, or `related`', 'Planner has no `reopen_card` tool', 'reopen_card({cardId:"<id>"})', 'stopped or settled paused', 'independently reviewable or parallelizable']) if (!planText.includes(required)) throw new Error(`Typed Planner composition lacks '${required}'.`);
  const classicPlanText = classicWorkflows.cardTypes.get('goal').processPrompts.get(classicPlan.promptId).text;
  if (classicPlanText.includes('Planner has no `reopen_card` tool') || classicPlanText.includes('reopen_card({cardId:"<id>"})')) throw new Error('Typed planning guidance leaked into the classic template.');
  const architecture = typedWorkflows.cardTypes.get('architecture');
  for (const nodeId of ['component-review', 'system-review']) {
    const node = architecture.states.get(`node:${nodeId}`);
    if (node.kind !== 'node') throw new Error(`Missing ${nodeId}.`);
    const agent = renderCompiledPrompt('architecture', node.agent.name, node.selectedAgentPrompt.compiled, { contractDescription: 'contract' });
    if (node.selectedAgentPrompt.source !== 'bundled-shared' || !agent.includes('record:///review.md?card=<card-id>') || !architecture.processPrompts.get(node.promptId).text.includes('record:///review.md?card=<card-id>')) throw new Error(`${nodeId} does not compose the shared Reviewer with current review.md.`);
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
    eventLogger: createEventLog(projectRoot, NO_FRESHNESS_EFFECTS.timelineChanged),
    workflows,
    providerRegistry,
    cardStore: new CardService(projectRoot, workflows, NO_FRESHNESS_EFFECTS),
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
