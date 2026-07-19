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
  { ReadModelChangeBroadcaster },
  { CardService },
  { createResolvedConfigAuthority },
  { EventBus },
  { createEventLog },
] = await Promise.all([
  import(compiledModule('agents/config-schema.js')),
  import(compiledModule('agents/default-card-processes.js')),
  import(compiledModule('application/runtime-composition.js')),
  import(compiledModule('application/read-model-changes.js')),
  import(compiledModule('cards/card-service.js')),
  import(compiledModule('config/index.js')),
  import(compiledModule('events/index.js')),
  import(compiledModule('observability/index.js')),
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
  const eventBus = new EventBus();
  const readModelChanges = new ReadModelChangeBroadcaster();
  const appLogs = { projectRoot, changes: readModelChanges };
  const configAuthority = createResolvedConfigAuthority({
    path: join(projectRoot, '.saivage', 'saivage.yaml'),
    source: { kind: 'default' },
    interpolationEnvironment: process.env,
  });

  application = createRuntimeApplication({
    projectRoot,
    processIdentity: { pid: process.pid, startedAt: new Date().toISOString() },
    config,
    configAuthority,
    eventBus,
    eventLogger: createEventLog(projectRoot, appLogs, eventBus),
    appLogs,
    cardStore: new CardService(projectRoot, eventBus, readModelChanges),
    readModelChanges,
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
