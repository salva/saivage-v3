import { initProjectTree, CardStore } from '../helpers/canonical-project.js';
import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { AnalystRuntime } from '../../src/agents/analyst-handler.js';
import { EventBus } from '../../src/events/bus.js';
import { initRuntimeState } from '../helpers/runtime-state.js';
import { createTestAnalystRuntime, loadTestConfig } from '../helpers/test-runtime-application.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';


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
  writeFileSync(join(sd, 'saivage.yaml'), JSON.stringify({
    models: { default: ['test-model'], analyst: ['test-model'] },
    providers: { test: { models: ['test-model'], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
  }));
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

  it('broadcasts read payload', async () => {
    const root = setupRoot();
    try {
      writeFileSync(join(root, 'README.md'), 'hello');
      mockToolCall('read', { path: 'project:///README.md' });
      const runtime = new AnalystRuntime({ projectRoot: root, promptTemplates: createTestPromptTemplateRegistry(), config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root, eventBus }) });
      await runtime.submit('global', { userContent: 'inspect README.md' });
      expect(broadcasts.length).toBeGreaterThan(0);
      const payload = broadcasts.at(-1) as BroadcastPayload;
      expect(payload.sessionId).toBe('analyst:global');
      expect(payload.tool).toBe('read');
      expect(payload.success).toBe(true);
      expect(payload.summary).toMatch(/read file/i);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('broadcasts exposed card-management payload and preserves related card id', async () => {
    const root = setupRoot();
    try {
      mockToolCall('delete_card', { ids: ['card-1'] });
      const runtime = new AnalystRuntime({ projectRoot: root, promptTemplates: createTestPromptTemplateRegistry(), config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root, eventBus }) });
      await runtime.submit('global', { userContent: 'delete card card-1' });
      const payload = broadcasts.at(-1) as BroadcastPayload;
      expect(payload.tool).toBe('delete_card');
      expect(payload.success).toBe(true);
      expect(payload.summary.length).toBeGreaterThan(0);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('broadcasts failed command payload', async () => {
    const root = setupRoot();
    try {
      mockToolCall('run_command', { command: 'false' });
      const runtime = new AnalystRuntime({ projectRoot: root, promptTemplates: createTestPromptTemplateRegistry(), config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root, eventBus }) });
      await runtime.submit('global', { userContent: 'run false' });
      const payload = broadcasts.at(-1) as BroadcastPayload;
      expect(payload.tool).toBe('run_command');
      expect(payload.success).toBe(true);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('broadcasts successful command payload', async () => {
    const root = setupRoot();
    try {
      mockToolCall('run_command', { command: 'printf ok' });
      const runtime = new AnalystRuntime({ projectRoot: root, promptTemplates: createTestPromptTemplateRegistry(), config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root, eventBus }) });
      await runtime.submit('global', { userContent: 'run printf ok' });
      const payload = broadcasts.at(-1) as BroadcastPayload;
      expect(payload.tool).toBe('run_command');
      expect(payload.success).toBe(true);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('exposes canonical command tools in telegram tool registration', async () => {
    const root = setupRoot();
    try {
      const runtime = new AnalystRuntime({ projectRoot: root, promptTemplates: createTestPromptTemplateRegistry(), config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root, eventBus }) });
      expect(runtime.getAvailableToolNames('analyst', 'telegram')).toContain('run_command');
      expect(runtime.getAvailableToolNames('analyst', 'telegram')).toContain('kill_process');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
