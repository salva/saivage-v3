import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startApp, type App } from '../../src/boot/app.js';
import { publishInitialProjectRuntime } from '../../src/boot/project-runtime-bootstrap.js';
import { CardService } from '../../src/cards/card-service.js';
import { appendConversationBatch, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { appLogFile, cardConversationVersionFile, cardConversationVersionIndexFile, cardRecordStreamFile, globalAgentConversationRoot, globalAgentConversationVersionFile, globalAgentConversationVersionIndexFile, runtimeProcessLockFile, saivageCardsRoot, saivageWorkRoot } from '../../src/persistence/layout.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { replaceConfigYaml } from '../../src/config/config-file.js';
import { initializeAndValidateCurrentGeneratedState } from '../../src/persistence/current-generated-graph.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { agentMessageSchema, cardAgentSessionId } from '../../src/schemas/index.js';
import { testRecordDefinition } from '../helpers/record-definitions.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { specializedCardTypes } from '../helpers/specialized-config.js';
import { resolveSystemTemplate } from '../../src/config/system-templates/registry.js';

const roots: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.stop();
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('application startup generated-state admission', () => {
  it('rejects a bare ordinary start before creating runtime layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-app-startup-bare-')); roots.push(root);
    await expect(start(root, false)).rejects.toThrow(/Project identity is missing/);
    expect(existsSync(join(root, '.saivage'))).toBe(false);
  });

  it('rejects ordinary start without project authority before optional effects and releases the lifecycle lock', async () => {
    const root = projectRoot(); const workflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
    publishInitialProjectRuntime(root, workflows);
    const timestamp = '2026-08-14T00:00:00.000Z';
    appendConversationBatch({ projectRoot: root }, [agentMessageSchema.parse({ id: 'activation', context_policy: { kind: 'structural', behavior: 'activation_boundary' }, session_id: 'agent:analyst:global', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'analyst', input_id: '00000000-0000-4000-8000-000000000001', timestamp }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp })]);
    const segment = readCurrentConversationSegment(root, 'agent:analyst:global')!;
    const conversationPath = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename); appendFileSync(conversationPath, 'unterminated');
    const conversationBytes = readFileSync(conversationPath); const globalIndexBytes = readFileSync(globalAgentConversationVersionIndexFile(root, 'analyst'));
    rmSync(saivageCardsRoot(root), { recursive: true });

    await expect(start(root, false)).rejects.toThrow(/Required project card authority is missing/);
    expect(existsSync(appLogFile(root))).toBe(false);
    expect(existsSync(cardRecordStreamFile(root, 'project', testRecordDefinition('status.md', 'project')))).toBe(false);
    expect(readFileSync(globalAgentConversationVersionIndexFile(root, 'analyst'))).toEqual(globalIndexBytes);
    expect(readFileSync(conversationPath)).toEqual(conversationBytes);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it('publishes initial runtime authority before unified admission when --create-runtime is explicit', async () => {
    const root = projectRoot();
    const app = await start(root, true); apps.push(app);
    expect(existsSync(saivageCardsRoot(root))).toBe(true);
    expect(existsSync(cardRecordStreamFile(root, 'project', testRecordDefinition('brief.md', 'project')))).toBe(true);
    expect(existsSync(globalAgentConversationRoot(root, 'oversight'))).toBe(false);
    expect(app.server.fastify.server.address()).not.toBeNull();
    apps.pop(); await app.stop();
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it.each([
    { label: 'ordinary start', createRuntime: false },
    { label: 'existing-state start --create-runtime', createRuntime: true },
  ])('rejects $label with a newly configured missing session before server-owned effects', async ({ createRuntime }) => {
    const root = projectRoot();
    const originalWorkflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
    publishInitialProjectRuntime(root, originalWorkflows);
    const cards = new CardService(root, originalWorkflows);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Retained child', bootstrap_content: 'Retained brief.', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const timestamp = '2026-08-14T00:00:00.000Z';
    const oldSessionId = cardAgentSessionId('executor', child.id);
    appendConversationBatch({ projectRoot: root }, [agentMessageSchema.parse({ id: `executor-${createRuntime}`, context_policy: { kind: 'structural', behavior: 'activation_boundary' }, session_id: oldSessionId, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'executor', card_id: child.id, input_id: '00000000-0000-4000-8000-000000000003', timestamp }), round_id: `r-pre-${'2'.repeat(32)}`, message_index: 0, block_index: 0, timestamp })]);
    const oldIndex = cardConversationVersionIndexFile(root, child.id, 'executor');
    const oldIndexBytes = readFileSync(oldIndex);
    const oldSegment = readCurrentConversationSegment(root, oldSessionId)!;
    const oldSegmentPath = cardConversationVersionFile(root, child.id, 'executor', oldSegment.entry.filename);
    const oldSegmentBytes = readFileSync(oldSegmentPath);
    const cardPath = join(root, '.saivage', 'cards', 'project', 'children', 'a', 'card.jsonl');
    const cardBytes = readFileSync(cardPath);
    const changed = renamedExecutorConfig();
    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), changed);
    const replacementIndex = cardConversationVersionIndexFile(root, child.id, 'executor-v2');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(start(root, createRuntime)).rejects.toThrow(
      `Required conversation index for current configured session 'agent:executor-v2:${child.id}' is missing from initialized generated state. Startup will not create a replacement session.`,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(appLogFile(root))).toBe(false);
    expect(existsSync(saivageWorkRoot(root))).toBe(false);
    expect(existsSync(replacementIndex)).toBe(false);
    expect(readFileSync(oldIndex)).toEqual(oldIndexBytes);
    expect(readFileSync(oldSegmentPath)).toEqual(oldSegmentBytes);
    expect(readFileSync(cardPath)).toEqual(cardBytes);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it('admits retained state after a never-used Oversight selection change and ignores unused declarations', async () => {
    const root = projectRoot();
    publishInitialProjectRuntime(root, compileProjectWorkflows(TEST_SAIVAGE_CONFIG));
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.agents['oversight-v2'] = { ...config.agents.oversight! };
    config.agents['unused-worker'] = { ...config.agents.executor! };
    config.oversight.agent = 'oversight-v2';
    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), config);

    expect(existsSync(globalAgentConversationRoot(root, 'oversight'))).toBe(false);
    expect(existsSync(globalAgentConversationRoot(root, 'oversight-v2'))).toBe(false);
    expect(existsSync(globalAgentConversationRoot(root, 'unused-worker'))).toBe(false);
    const app = await start(root, false); apps.push(app);
    expect(app.server.fastify.server.address()).not.toBeNull();
    expect(existsSync(globalAgentConversationRoot(root, 'oversight-v2'))).toBe(false);
    expect(existsSync(globalAgentConversationRoot(root, 'unused-worker'))).toBe(false);
  });

  it('uses the same typed root and create intent for locking and environment loading', async () => {
    const root = projectRoot();
    const shadowedRoot = mkdtempSync(join(tmpdir(), 'saivage-app-shadowed-root-')); roots.push(shadowedRoot);
    const config = join(root, '.saivage', 'saivage.yaml');
    const app = await startApp({
      projectRoot: root, config, host: '127.0.0.1', port: '0', createRuntime: true,
      env: {
        NODE_ENV: 'test', SAIVAGE_PROJECT_ROOT: join(shadowedRoot, 'missing'),
        SAIVAGE_CONFIG: join(shadowedRoot, 'missing.yaml'), SAIVAGE_HOST: 'shadowed.invalid', SAIVAGE_PORT: 'malformed',
      },
    });
    apps.push(app);
    expect(app.environment).toMatchObject({ projectRoot: root, server: { host: '127.0.0.1', port: 0 } });
    expect(existsSync(saivageCardsRoot(root))).toBe(true);
    expect(existsSync(join(shadowedRoot, '.saivage'))).toBe(false);
  });

  it('boots a newly published runtime with the explicit specialized compiled authority',async()=>{
    const root=projectRoot();replaceConfigYaml(join(root,'.saivage','saivage.yaml'),selectedSpecializedConfig());cpSync(resolveSystemTemplate('classic-typed').promptRoot,join(root,'.saivage','config','prompts'),{recursive:true});
    const app=await start(root,true);apps.push(app);
    expect(app.environment.config.card_types.test!.workflow.nodes).toHaveProperty('add-coverage');
    expect(app.environment.config.card_types.architecture!.workflow.nodes).toHaveProperty('component-review');
    expect(app.environment.config.card_types.architecture!.workflow.nodes).toHaveProperty('system-review');
    expect(app.environment.workflows.cardTypes.get('architecture')!.states).toHaveProperty('get');
    expect(app.environment.workflows.cardTypes.get('architecture')!.states.get('node:system-review')).toMatchObject({kind:'node',nodeId:'system-review'});
  });

  it('fails startup on a present empty declared optional stream without changing it',async()=>{
    const root=projectRoot();publishInitialProjectRuntime(root,compileProjectWorkflows(TEST_SAIVAGE_CONFIG));const stream=cardRecordStreamFile(root,'project',testRecordDefinition('status.md','project'));writeFileSync(stream,'');
    await expect(start(root,false)).rejects.toThrow();expect(readFileSync(stream)).toEqual(Buffer.alloc(0));expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it('rejects retained explicit-family authority after selecting standard before optional effects and releases the lifecycle lock', async () => {
    const root = projectRoot();
    const explicitConfig = explicitFixtureFamilyConfig();
    const explicitWorkflows = compileProjectWorkflows(explicitConfig);
    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), explicitConfig);
    publishInitialProjectRuntime(root, explicitWorkflows);
    new CardService(root, explicitWorkflows).create({ type: 'fixture-leaf', parent: 'project', title: 'Fixture-family child', bootstrap_content: 'Fixture-family authority.', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    expect(() => initializeAndValidateCurrentGeneratedState(root, explicitWorkflows)).not.toThrow();

    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), selectedStandardConfig());
        const timestamp = '2026-08-14T00:00:00.000Z';
    appendConversationBatch({ projectRoot: root }, [agentMessageSchema.parse({ id: 'set-change', context_policy: { kind: 'structural', behavior: 'activation_boundary' }, session_id: 'agent:analyst:global', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'analyst', input_id: '00000000-0000-4000-8000-000000000002', timestamp }), round_id: `r-pre-${'1'.repeat(32)}`, message_index: 0, block_index: 0, timestamp })]);
    const segment = readCurrentConversationSegment(root, 'agent:analyst:global')!;
    const conversationPath = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename);
    appendFileSync(conversationPath, 'unterminated');
    const conversationBytes = readFileSync(conversationPath);

    await expect(start(root, false)).rejects.toThrow(/No compiled workflow exists for card type 'fixture-leaf'/);
    expect(existsSync(appLogFile(root))).toBe(false);
    expect(existsSync(cardRecordStreamFile(root, 'project', testRecordDefinition('status.md', 'project')))).toBe(false);
    expect(readFileSync(conversationPath)).toEqual(conversationBytes);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });
});

function projectRoot(): string { const root = mkdtempSync(join(tmpdir(), 'saivage-app-startup-')); roots.push(root); createProjectIdentity(root, 'Startup test'); replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), TEST_SAIVAGE_CONFIG); return root; }
function start(root: string, createRuntime: boolean): Promise<App> { return startApp({ projectRoot: root, createRuntime, env: { NODE_ENV: 'test', SAIVAGE_PORT: '0', SAIVAGE_HOST: '127.0.0.1' } }); }
function explicitFixtureFamilyConfig() {
  const config = structuredClone(TEST_SAIVAGE_CONFIG);
  const project = config.card_types.project!;
  config.card_types.project = { ...project, permitted_child_types: [...project.permitted_child_types, 'fixture-leaf'] };
  config.card_types['fixture-leaf'] = structuredClone(config.card_types.code!);
  return effectiveSaivageConfigSchema.parse(config);
}
function selectedStandardConfig(): Record<string, unknown> { const config = structuredClone(TEST_SAIVAGE_CONFIG) as unknown as Record<string, unknown>; delete config['card_types']; return config; }
function selectedSpecializedConfig(): Record<string, unknown> { const config = structuredClone(TEST_SAIVAGE_CONFIG) as unknown as Record<string, unknown>; config['card_types'] = specializedCardTypes(); return config; }
function renamedExecutorConfig() {
  const config = structuredClone(TEST_SAIVAGE_CONFIG);
  config.agents['executor-v2'] = { ...config.agents.executor! };
  config.card_types.code!.workflow.notification_recipient = 'executor-v2';
  config.card_types.code!.workflow.nodes.execute!.agent = 'executor-v2';
  config.mcpServers = { admission_probe: { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp', autostart: true, disabled: false } };
  return config;
}
