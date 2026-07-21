#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
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

function compiledModule(relativePath) {
  return pathToFileURL(join(compiledRoot, relativePath)).href;
}

const [
  { saivageConfigSchema },
  { DEFAULT_CARD_PROCESSES },
  { createRuntimeApplication },
  { NO_FRESHNESS_EFFECTS },
  { CardService },
  { createResolvedConfigAuthority },
  { createEventLog },
  { ManagedProcessGroupRegistry },
  { ProcessRunner },
] = await Promise.all([
  import(compiledModule('agents/config-schema.js')),
  import(compiledModule('agents/default-card-processes.js')),
  import(compiledModule('application/runtime-composition.js')),
  import(compiledModule('application/freshness-effects.js')),
  import(compiledModule('cards/card-service.js')),
  import(compiledModule('config/index.js')),
  import(compiledModule('observability/index.js')),
  import(compiledModule('runtime/managed-process-group-registry.js')),
  import(compiledModule('runtime/process-runner.js')),
]);

const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-compiled-prompt-composition-'));
let application;

try {
  const config = saivageConfigSchema.parse({
    models: { default: ['test-model'], max_tokens: { analyst: 200 } },
    providers: { test: { models: ['test-model'] } },
    compaction: {
      enabled: true,
      input_budget_tokens: 1000,
      summarizer_candidate: { provider: 'test', account: null, model: 'test-model' },
    },
    card_processes: DEFAULT_CARD_PROCESSES,
  });
  const configAuthority = createResolvedConfigAuthority({
    path: join(projectRoot, '.saivage', 'saivage.yaml'),
    source: { kind: 'default' },
    interpolationEnvironment: process.env,
  });
  const processRegistry = new ManagedProcessGroupRegistry();
  const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime-cards');
  const analystProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'analyst-sessions');
  const processRunner = new ProcessRunner(projectRoot, processRegistry);
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
    cardStore: new CardService(projectRoot, NO_FRESHNESS_EFFECTS),
    freshness: NO_FRESHNESS_EFFECTS,
    processRunner,
    runtimeProcessRootScope,
    analystProcessRootScope,
    mcpToolInvocation,
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

console.log('Compiled production composition loaded role and process prompts from dist/prompts.');
