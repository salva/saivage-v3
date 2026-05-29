import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { AnalystHandler } from '../../src/agents/analyst-handler.js';
import { EventBus } from '../../src/events/bus.js';
import { initRuntimeState } from '../../src/runtime/state.js';
import { createTestActiveRuntime } from '../helpers/test-active-runtime.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


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
  for (const d of ['cards/by-id', 'cards/tree', 'cards/dependencies', 'notes/by-card', 'runtime', 'agents/sessions', 'agents/messages']) mkdirSync(join(sd, d), { recursive: true });
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({
    models: { analyst: ['test-model'] },
    providers: { test: { models: ['test-model'], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
  }));
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }));
  writeFileSync(join(sd, 'cards', 'by-id', 'c-1.json'), JSON.stringify({ id: 'c-1', type: 'code', parent: 'project', depth: 1, title: 'card', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' }, 'c-1': { id: 'c-1', type: 'code', parent: 'project', status: 'backlog', title: 'card' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify(['c-1']));
  writeFileSync(join(sd, 'cards', 'tree', 'c-1.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
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
      const handler = new AnalystHandler(root, createTestActiveRuntime({ eventBus }), undefined, 'analyst', 'web-chat');
      await handler.handleMessage('s1', 'inspect README.md');
      expect(broadcasts.length).toBeGreaterThan(0);
      const payload = broadcasts.at(-1) as BroadcastPayload;
      expect(payload.sessionId).toBe('s1');
      expect(payload.tool).toBe('read_file');
      expect(payload.success).toBe(true);
      expect(payload.summary).toMatch(/read file/i);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('broadcasts edit_card payload and preserves related card id', async () => {
    const root = setupRoot();
    try {
      mockToolCall('edit_card', { id: 'c-1', title: 'updated' });
      const handler = new AnalystHandler(root, createTestActiveRuntime({ eventBus }), undefined, 'analyst', 'web-chat');
      await handler.handleMessage('s2', 'edit card c-1 title updated');
      const payload = broadcasts.at(-1) as BroadcastPayload;
      expect(payload.tool).toBe('edit_card');
      expect(payload.success).toBe(false);
      expect(payload.summary.length).toBeGreaterThan(0);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('broadcasts denied secret-bearing shell payload without leaking real paths', async () => {
    const root = setupRoot();
    try {
      mockToolCall('run_shell_command', { command: 'cat .saivage/auth-profiles.json apiKey=super-secret' });
      const handler = new AnalystHandler(root, createTestActiveRuntime({ eventBus }), undefined, 'analyst', 'web-chat');
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
      const handler = new AnalystHandler(root, createTestActiveRuntime({ eventBus }), undefined, 'analyst', 'web-chat');
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
      const handler = new AnalystHandler(root, createTestActiveRuntime({ eventBus }), undefined, 'analyst', 'telegram');
      expect(handler.getAvailableToolNames()).not.toContain('run_shell_command');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
