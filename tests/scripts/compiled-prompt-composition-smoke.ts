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
const { compileProjectWorkflows, bindRuntimeWorkflows, describeNodeResultContract } = await import('../../src/runtime/card-process/card-process-config.js');
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

const WORKFLOW_ROLES = ['planner', 'executor', 'reviewer'] as const;
const SHIPPED_ROLES = [...WORKFLOW_ROLES, 'analyst'] as const;
type ShippedRole = typeof SHIPPED_ROLES[number];

function assertGuidanceComposition(text: string, promptRoot: string, role: ShippedRole, context: string): void {
  const fragmentRoot = join(promptRoot, 'fragments', '_shared');
  const common = readFileSync(join(fragmentRoot, 'project-guidance-common.md'), 'utf8');
  const matching = readFileSync(join(fragmentRoot, `project-guidance-${role}.md`), 'utf8');
  if (text.split(common).length - 1 !== 1) throw new Error(`Common project guidance is not rendered exactly once for ${context}.`);
  if (text.split(matching).length - 1 !== 1) throw new Error(`Matching project guidance is not rendered exactly once for ${context}.`);
  for (const otherRole of SHIPPED_ROLES) {
    if (otherRole === role) continue;
    const other = readFileSync(join(fragmentRoot, `project-guidance-${otherRole}.md`), 'utf8');
    if (text.includes(other)) throw new Error(`Other-role project guidance '${otherRole}' is rendered for ${context}.`);
  }
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
      context_utilization_fraction: 0.8,
      summarizer_candidate: { provider: 'test', account: null, model: 'test-model' },
    },
  });
  const { card_types: _defaultCardTypes, ...globals } = structuredClone(baseConfig);
  const classicTestConfig = effectiveSaivageConfigSchema.parse({ ...structuredClone(globals), card_types: structuredClone(classic.config.card_types) });
  const typedTestConfig = effectiveSaivageConfigSchema.parse({ ...structuredClone(globals), card_types: structuredClone(classicTyped.config.card_types) });
  const classicWorkflows = compileProjectWorkflows(classicTestConfig, { projectRoot, artifactObserver: observeInside('classic', classic.promptRoot) });
  const typedWorkflows = compileProjectWorkflows(typedTestConfig, { defaultPromptRoot: classicTyped.promptRoot, projectRoot, artifactObserver: observeInside('classic-typed', classicTyped.promptRoot) });
  const classicSourceRoot = join(repositoryRoot, 'src', 'config', 'system-templates', 'classic', 'prompts');
  const typedSourceRoot = join(repositoryRoot, 'src', 'config', 'system-templates', 'classic-typed', 'prompts');
  const classicSourceWorkflows = compileProjectWorkflows(classicTestConfig, { defaultPromptRoot: classicSourceRoot, projectRoot, artifactObserver: observeInside('classic source', classicSourceRoot) });
  const typedSourceWorkflows = compileProjectWorkflows(typedTestConfig, { defaultPromptRoot: typedSourceRoot, projectRoot, artifactObserver: observeInside('classic-typed source', typedSourceRoot) });
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
  const assertRoleComposition = (
    templateName: string,
    packagedRoot: string,
    sourceRoot: string,
    packaged: ReturnType<typeof compileProjectWorkflows>,
    source: ReturnType<typeof compileProjectWorkflows>,
  ) => {
    const composedWorkflowRoles = new Set<ShippedRole>();
    for (const [cardType, packagedProcess] of packaged.cardTypes) {
      const sourceProcess = requireValue(source.cardTypes.get(cardType), `Missing source ${templateName}/${cardType} workflow.`);
      for (const [stateId, packagedState] of packagedProcess.states) {
        if (packagedState.kind !== 'node') continue;
        const sourceState = requireValue(sourceProcess.states.get(stateId), `Missing source ${templateName}/${cardType}/${stateId}.`);
        if (sourceState.kind !== 'node') throw new Error(`Source ${templateName}/${cardType}/${stateId} is not a node.`);
        const packagedContract = describeNodeResultContract(packagedProcess, stateId);
        const sourceContract = describeNodeResultContract(sourceProcess, stateId);
        const packagedInstruction = renderCompiledPrompt({ kind: 'workflow-agent', cardType }, packagedState.agent.name, packagedState.selectedAgentPrompt.compiled, { contractDescription: packagedContract });
        const sourceInstruction = renderCompiledPrompt({ kind: 'workflow-agent', cardType }, sourceState.agent.name, sourceState.selectedAgentPrompt.compiled, { contractDescription: sourceContract });
        if (packagedState.agent.name !== sourceState.agent.name || packagedState.selectedAgentPrompt.reference !== sourceState.selectedAgentPrompt.reference || packagedContract !== sourceContract || packagedInstruction !== sourceInstruction) throw new Error(`Source/package role composition differs for ${templateName}/${cardType}/${stateId}.`);
        if (packagedInstruction.split(packagedContract).length - 1 !== 1) throw new Error(`Generated role contract is not rendered exactly once for ${templateName}/${cardType}/${stateId}.`);
        const role = WORKFLOW_ROLES.find((candidate) => candidate === packagedState.selectedAgentPrompt.reference);
        if (role) {
          composedWorkflowRoles.add(role);
          assertGuidanceComposition(packagedInstruction, packagedRoot, role, `${templateName} packaged ${cardType}/${stateId}`);
          assertGuidanceComposition(sourceInstruction, sourceRoot, role, `${templateName} source ${cardType}/${stateId}`);
        }
      }
    }
    if (WORKFLOW_ROLES.some((role) => !composedWorkflowRoles.has(role))) throw new Error(`Not all shipped workflow roles were composed for ${templateName}.`);

    if (packaged.analyst.name !== source.analyst.name || packaged.analystPrompt.reference !== 'analyst' || source.analystPrompt.reference !== 'analyst') throw new Error(`Analyst source selection differs for ${templateName}.`);
    const packagedAnalyst = renderCompiledPrompt({ kind: 'global-agent' }, packaged.analyst.name, packaged.analystPrompt.compiled, { vocabularySnippet: 'vocabulary' });
    const sourceAnalyst = renderCompiledPrompt({ kind: 'global-agent' }, source.analyst.name, source.analystPrompt.compiled, { vocabularySnippet: 'vocabulary' });
    if (packagedAnalyst !== sourceAnalyst) throw new Error(`Source/package Analyst composition differs for ${templateName}.`);
    assertGuidanceComposition(packagedAnalyst, packagedRoot, 'analyst', `${templateName} packaged Analyst`);
    assertGuidanceComposition(sourceAnalyst, sourceRoot, 'analyst', `${templateName} source Analyst`);
  };
  assertRoleComposition('classic', classic.promptRoot, classicSourceRoot, classicWorkflows, classicSourceWorkflows);
  assertRoleComposition('classic-typed', classicTyped.promptRoot, typedSourceRoot, typedWorkflows, typedSourceWorkflows);
  const assertPlanningComposition = (templateName: string, packaged: ReturnType<typeof compileProjectWorkflows>, source: ReturnType<typeof compileProjectWorkflows>) => {
    for (const cardType of ['project', 'goal'] as const) {
      const packagedProcess = requireValue(packaged.cardTypes.get(cardType), `Missing packaged ${templateName}/${cardType} workflow.`);
      const sourceProcess = requireValue(source.cardTypes.get(cardType), `Missing source ${templateName}/${cardType} workflow.`);
      for (const nodeId of ['plan', 'recover'] as const) {
        const packagedNode = requireValue(packagedProcess.states.get(`node:${nodeId}`), `Missing packaged ${templateName}/${cardType}/${nodeId}.`);
        const sourceNode = requireValue(sourceProcess.states.get(`node:${nodeId}`), `Missing source ${templateName}/${cardType}/${nodeId}.`);
        if (packagedNode.kind !== 'node' || sourceNode.kind !== 'node') throw new Error(`Planning state is not a node for ${templateName}/${cardType}/${nodeId}.`);
        const packagedContract = describeNodeResultContract(packagedProcess, `node:${nodeId}`);
        const sourceContract = describeNodeResultContract(sourceProcess, `node:${nodeId}`);
        const packagedAgent = renderCompiledPrompt({ kind: 'workflow-agent', cardType }, packagedNode.agent.name, packagedNode.selectedAgentPrompt.compiled, { contractDescription: packagedContract });
        const sourceAgent = renderCompiledPrompt({ kind: 'workflow-agent', cardType }, sourceNode.agent.name, sourceNode.selectedAgentPrompt.compiled, { contractDescription: sourceContract });
        const packagedProcessPrompt = requireValue(packagedProcess.processPrompts.get(packagedNode.promptId), `Missing packaged ${templateName}/${cardType}/${nodeId} process prompt.`);
        const sourceProcessPrompt = requireValue(sourceProcess.processPrompts.get(sourceNode.promptId), `Missing source ${templateName}/${cardType}/${nodeId} process prompt.`);
        if (packagedNode.selectedAgentPrompt.source !== 'bundled-shared' || sourceNode.selectedAgentPrompt.source !== 'bundled-shared' || packagedNode.selectedAgentPrompt.reference !== 'planner' || sourceNode.selectedAgentPrompt.reference !== 'planner') throw new Error(`Planner source selection changed for ${templateName}/${cardType}/${nodeId}.`);
        if (packagedContract !== sourceContract || packagedAgent !== sourceAgent || packagedProcessPrompt.reference !== sourceProcessPrompt.reference || packagedProcessPrompt.text !== sourceProcessPrompt.text) throw new Error(`Source/package Planner rendering differs for ${templateName}/${cardType}/${nodeId}.`);
        if (packagedAgent.split(packagedContract).length - 1 !== 1) throw new Error(`Generated Planner contract is not rendered exactly once for ${templateName}/${cardType}/${nodeId}.`);
      }
      const packagedPlan = requireValue(packagedProcess.states.get('node:plan'), `Missing packaged ${templateName}/${cardType}/plan.`);
      const packagedReview = requireValue(packagedProcess.states.get('node:review'), `Missing packaged ${templateName}/${cardType}/review.`);
      const sourcePlan = requireValue(sourceProcess.states.get('node:plan'), `Missing source ${templateName}/${cardType}/plan.`);
      const sourceReview = requireValue(sourceProcess.states.get('node:review'), `Missing source ${templateName}/${cardType}/review.`);
      if (packagedPlan.kind !== 'node' || packagedReview.kind !== 'node' || sourcePlan.kind !== 'node' || sourceReview.kind !== 'node') throw new Error(`Missing planning transition node for ${templateName}/${cardType}.`);
      const transitionShape = (process: typeof packagedProcess, planNode: typeof packagedPlan, reviewNode: typeof packagedReview) => ({
        stopped: process.states.get('entry:STOPPED')?.on.get('entry:route'),
        reviewAdmission: planNode.on.get('result:admit_review'),
        reviewRevision: reviewNode.on.get('result:revision_required'),
      });
      if (JSON.stringify(transitionShape(packagedProcess, packagedPlan, packagedReview)) !== JSON.stringify(transitionShape(sourceProcess, sourcePlan, sourceReview))) throw new Error(`Source/package Planner transition references differ for ${templateName}/${cardType}.`);
    }
  };
  assertPlanningComposition('classic', classicWorkflows, classicSourceWorkflows);
  assertPlanningComposition('classic-typed', typedWorkflows, typedSourceWorkflows);
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
  const workflows = bindRuntimeWorkflows(typedWorkflows, new ModelRouter(providerRegistry), providerRegistry, typedTestConfig.compaction.context_utilization_fraction);
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
