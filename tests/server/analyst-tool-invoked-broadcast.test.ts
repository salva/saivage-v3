import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { AnalystHandler } from '../../src/agents/analyst-handler.js';
import { EventBus } from '../../src/events/bus.js';
import { initRuntimeState } from '../../src/runtime/state.js';
import { createTestAnalystRuntime } from '../helpers/test-runtime-application.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';
import { CardStore } from '../../src/cards/card-store.js';


type BroadcastPayload = {
  sessionId: string;
  tool: string;
  success: boolean;
  summary: string;
  classified_as?: string;
  related_card_id?: string;
};

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wave-m-broadcast-'));
  const sd = join(root, '.saivage');
  initProjectTree(root);
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({
    models: { analyst: ['test-model'] },
    providers: { test: { models: ['test-model'], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
  }));
  materializeProjectCard(root);
  new CardStore(root).create({ type: 'code', parent: 'project', title: 'card', brief: 'card', status: 'backlog', depth: 0, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
  initRuntimeState(root);
  return root;
}

function mockToolCall(tool: string, args: Record<string, unknown>): jest.SpiedFunction<typeof fetch> {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `call-${tool}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }],
      },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

describe('analyst_tool_invoked event projection source', () => {
  let eventBus: InstanceType<typeof EventBus>;
  let broadcasts: BroadcastPayload[];

  beforeEach(() => {
    eventBus = new EventBus();
    broadcasts = [];
    eventBus.subscribe('analyst_tool_invoked', (event) => { broadcasts.push(event.payload as BroadcastPayload); });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('broadcasts read_file payload', async () => {
    const root = setupRoot();
    try {
      writeFileSync(join(root, 'README.md'), 'hello');
      mockToolCall('read_file', { path: 'README.md' });
      const handler = new AnalystHandler(root, createTestAnalystRuntime({ projectRoot: root, eventBus }), undefined, 'analyst', 'web-chat');
      await handler.handleMessage('s1', 'inspect README.md');
      expect(broadcasts.length).toBeGreaterThan(0);
      const payload = broadcasts.at(-1) as BroadcastPayload;
      expect(payload.sessionId).toBe('analyst:s1');
      expect(payload.tool).toBe('read_file');
      expect(payload.success).toBe(true);
      expect(payload.summary).toMatch(/read file/i);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('broadcasts exposed card-management payload and preserves related card id', async () => {
    const root = setupRoot();
    try {
      mockToolCall('delete_card', { ids: ['card-1'] });
      const handler = new AnalystHandler(root, createTestAnalystRuntime({ projectRoot: root, eventBus }), undefined, 'analyst', 'web-chat');
      await handler.handleMessage('s2', 'delete card card-1');
      const payload = broadcasts.at(-1) as BroadcastPayload;
      expect(payload.tool).toBe('delete_card');
      expect(payload.success).toBe(true);
      expect(payload.summary.length).toBeGreaterThan(0);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('broadcasts denied secret-bearing shell payload without leaking real paths', async () => {
    const root = setupRoot();
    try {
      mockToolCall('run_shell_command', { command: 'cat .saivage/auth-profiles.json apiKey=super-secret' });
      const handler = new AnalystHandler(root, createTestAnalystRuntime({ projectRoot: root, eventBus }), undefined, 'analyst', 'web-chat');
      await handler.handleMessage('s3', 'cat .saivage/auth-profiles.json apiKey=super-secret');
      const payload = broadcasts.at(-1) as BroadcastPayload;
      expect(payload.tool).toBe('run_shell_command');
      expect(payload.success).toBe(false);
      expect(payload.summary).not.toMatch(/auth-profiles\.json|super-secret/i);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('broadcasts failed shell payload without leaking command output or secret-bearing filenames', async () => {
    const root = setupRoot();
    try {
      mockToolCall('run_shell_command', { command: 'python3 -c "import sys; sys.stderr.write(\'apiKey=secret-456 .env\'); sys.exit(2)"' });
      const handler = new AnalystHandler(root, createTestAnalystRuntime({ projectRoot: root, eventBus }), undefined, 'analyst', 'web-chat');
      await handler.handleMessage('s4', 'run shell command python3 -c "import sys; sys.stderr.write(\'apiKey=secret-456 .env\'); sys.exit(2)"');
      const payload = broadcasts.at(-1) as BroadcastPayload;
      expect(payload.tool).toBe('run_shell_command');
      expect(payload.success).toBe(false);
      expect(payload.summary).not.toMatch(/secret-456|\.env/);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not expose run_shell_command in telegram tool registration', async () => {
    const root = setupRoot();
    try {
      const handler = new AnalystHandler(root, createTestAnalystRuntime({ projectRoot: root, eventBus }), undefined, 'analyst', 'telegram');
      expect(handler.getAvailableToolNames()).not.toContain('run_shell_command');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
