import { afterEach, describe, expect, it } from '@jest/globals';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startApp, type App } from '../../src/boot/app.js';
import { publishInitialProjectRuntime } from '../../src/boot/project-runtime-bootstrap.js';
import { appendConversationBatch, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { appLogFile, cardRecordVersionIndexFile, globalAgentConversationVersionFile, globalAgentConversationVersionIndexFile, runtimeProcessLockFile, saivageCardsRoot } from '../../src/persistence/layout.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { replaceConfigYaml } from '../../src/config/config-file.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { agentMessageSchema } from '../../src/schemas/index.js';
import { testRecordDefinition } from '../helpers/record-definitions.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const roots: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.stop();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('application startup generated-state admission', () => {
  it('rejects ordinary start without project authority before optional effects and releases the lifecycle lock', async () => {
    const root = projectRoot(); const workflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
    publishInitialProjectRuntime(root, workflows);
    const timestamp = '2026-08-14T00:00:00.000Z';
    appendConversationBatch({ projectRoot: root }, [agentMessageSchema.parse({ id: 'activation', session_id: 'agent:analyst:global', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'analyst', input_id: '00000000-0000-4000-8000-000000000001', timestamp }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp })]);
    const segment = readCurrentConversationSegment(root, 'agent:analyst:global')!;
    const conversationPath = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename); appendFileSync(conversationPath, 'unterminated');
    const conversationBytes = readFileSync(conversationPath); const globalIndexBytes = readFileSync(globalAgentConversationVersionIndexFile(root, 'analyst'));
    rmSync(saivageCardsRoot(root), { recursive: true });

    await expect(start(root, false)).rejects.toThrow(/Required project card authority is missing/);
    expect(existsSync(appLogFile(root))).toBe(false);
    expect(existsSync(cardRecordVersionIndexFile(root, 'project', testRecordDefinition('status.md', 'project')))).toBe(false);
    expect(readFileSync(globalAgentConversationVersionIndexFile(root, 'analyst'))).toEqual(globalIndexBytes);
    expect(readFileSync(conversationPath)).toEqual(conversationBytes);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it('publishes initial runtime authority before unified admission when --create-runtime is explicit', async () => {
    const root = projectRoot();
    const app = await start(root, true); apps.push(app);
    expect(existsSync(saivageCardsRoot(root))).toBe(true);
    expect(existsSync(cardRecordVersionIndexFile(root, 'project', testRecordDefinition('status.md', 'project')))).toBe(true);
    expect(app.server.fastify.server.address()).not.toBeNull();
    apps.pop(); await app.stop();
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });
});

function projectRoot(): string { const root = mkdtempSync(join(tmpdir(), 'saivage-app-startup-')); roots.push(root); createProjectIdentity(root, 'Startup test'); replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), TEST_SAIVAGE_CONFIG); return root; }
function start(root: string, createRuntime: boolean): Promise<App> { return startApp({ argv: ['node', 'saivage', 'start', '--project-root', root, ...(createRuntime ? ['--create-runtime'] : [])], env: { NODE_ENV: 'test', SAIVAGE_PORT: '0', SAIVAGE_HOST: '127.0.0.1' } }); }
