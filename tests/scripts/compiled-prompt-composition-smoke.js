#!/usr/bin/env node

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distRoot = join(repositoryRoot, 'dist');
const compiledRoot = join(distRoot, 'src');
const copiedPrompts = join(distRoot, 'prompts');
const impossibleSourceRelativePrompts = join(compiledRoot, 'prompts');

if (!existsSync(copiedPrompts) || !statSync(copiedPrompts).isDirectory()) {
  throw new Error(`Compiled prompt smoke requires copied prompt defaults at ${copiedPrompts}`);
}
if (existsSync(impossibleSourceRelativePrompts)) {
  throw new Error(`Compiled prompt smoke requires the source-relative prompt root to be absent: ${impossibleSourceRelativePrompts}`);
}
const walk = (root, current = root) => readdirSync(current, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(root, join(current, entry.name)) : [join(current, entry.name).slice(root.length + 1)]).sort();
const expected = [...['analyst','executor','planner','reviewer'].map((id)=>`agents/_shared/${id}.md`), ...['correct-execution-result','correct-plan-result','correct-review-result','execute','plan','plan-to-review','recover','review','review-to-plan','stopped-recovery'].map((id)=>`process/_shared/${id}.md`)].sort();
if (JSON.stringify(walk(copiedPrompts)) !== JSON.stringify(expected)) throw new Error('Compiled prompt smoke requires the exact 14-file bundled prompt inventory.');
if (existsSync(join(copiedPrompts, 'fragments'))) throw new Error('Compiled prompt smoke requires no bundled fragments subtree.');

function compiledModule(relativePath) {
  return pathToFileURL(join(compiledRoot, relativePath)).href;
}

const [
  { saivageConfigSchema },
  { DEFAULT_SAIVAGE_CONFIG },
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
  import(compiledModule('agents/default-workflow-config.js')),
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

const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-compiled-prompt-composition-'));
let application;

try {
  const config = saivageConfigSchema.parse({
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
  const structuralWorkflows = compileProjectWorkflows(config, { projectRoot });
  const analystText = renderCompiledPrompt('global', structuralWorkflows.analyst.name, structuralWorkflows.analystPrompt.compiled, { toolList: 'tools', vocabularySnippet: 'vocabulary', projectContext: 'context' });
  if (analystText.includes('{{')) throw new Error('Unresolved Analyst template syntax.');
  for (const [cardType, workflow] of structuralWorkflows.cardTypes) for (const prompt of workflow.processPrompts.values()) {
    if (prompt.text.includes('{{')) throw new Error(`Unresolved process template syntax for ${cardType}/${prompt.reference}`);
    if ((prompt.reference === 'execute' || prompt.reference === 'plan') && !prompt.text.includes(cardType)) throw new Error(`Missing eager cardType rendering for ${cardType}/${prompt.reference}`);
  }
  for (const [cardType, workflow] of structuralWorkflows.cardTypes) for (const state of workflow.states.values()) if (state.kind === 'node') {
    const text = renderCompiledPrompt(cardType, state.agent.name, state.selectedAgentPrompt.compiled, { cardId: 'card-a', cardTitle: 'Title', cardBrief: 'Brief', cardType, contractDescription: 'contract', toolList: 'tools' });
    if (text.includes('{{')) throw new Error(`Unresolved agent template syntax for ${cardType}/${state.agent.name}`);
  }
  const providerRegistry = new ProviderRegistry(config);
  const workflows = bindRuntimeWorkflows(structuralWorkflows, new ModelRouter(providerRegistry));
  const configAuthority = createResolvedConfigAuthority({
    path: join(projectRoot, '.saivage', 'saivage.yaml'),
    source: { kind: 'default' },
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
    config,
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

console.log('Compiled production composition loaded agent and process prompts from dist/prompts.');
