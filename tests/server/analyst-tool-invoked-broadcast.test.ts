import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const broadcastAnalystToolInvoked = jest.fn();
jest.unstable_mockModule('../../src/server/websocket.js', () => ({
  broadcastAnalystToolInvoked,
  broadcastControlActionRecorded: jest.fn(),
  broadcastNotificationAdded: jest.fn(),
  broadcastNotificationAcknowledged: jest.fn(),
  broadcastCardHistoryAppended: jest.fn(),
}));

const { AnalystHandler } = await import('../../src/agents/analyst-handler.js');
const { initRuntimeState } = await import('../../src/utils/runtime-state.js');

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

describe('analyst_tool_invoked broadcast', () => {
  beforeEach(() => {
    broadcastAnalystToolInvoked.mockReset();
  });

  it('broadcasts read_file payload', async () => {
    const root = setupRoot();
    try {
      writeFileSync(join(root, 'README.md'), 'hello');
      const handler = new AnalystHandler(root, undefined, undefined, 'analyst', 'web-chat');
      await handler['runOfflineFallback']('s1', 'inspect README.md');
      expect(broadcastAnalystToolInvoked).toHaveBeenCalled();
      const payload = broadcastAnalystToolInvoked.mock.calls.at(-1)?.[0] as BroadcastPayload;
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
      const handler = new AnalystHandler(root, undefined, undefined, 'analyst', 'web-chat');
      await handler['runOfflineFallback']('s2', 'edit card c-1 title updated');
      const payload = broadcastAnalystToolInvoked.mock.calls.at(-1)?.[0] as BroadcastPayload;
      expect(payload.tool).toBe('edit_card');
      expect(payload.success).toBe(true);
      expect(payload.summary.length).toBeGreaterThan(0);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
      expect(payload.related_card_id).toBe('c-1');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('broadcasts previewed destructive shell payload with classification and redacted secret paths', async () => {
    const root = setupRoot();
    try {
      const handler = new AnalystHandler(root, undefined, undefined, 'analyst', 'web-chat');
      await handler['runOfflineFallback']('s3', 'cat .saivage/auth-profiles.json apiKey=super-secret');
      const payload = broadcastAnalystToolInvoked.mock.calls.at(-1)?.[0] as BroadcastPayload;
      expect(payload.tool).toBe('run_shell_command');
      expect(payload.classified_as).toBe('destructive');
      expect(payload.success).toBe(true);
      expect(payload.summary).toContain('[SECRET_PATH]');
      expect(payload.summary).not.toMatch(/auth-profiles\.json|super-secret/i);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('broadcasts failed shell payload without leaking command output or secret-bearing filenames', async () => {
    const root = setupRoot();
    try {
      const handler = new AnalystHandler(root, undefined, undefined, 'analyst', 'web-chat');
      await handler['runOfflineFallback']('s4', 'run shell command python3 -c "import sys; sys.stderr.write(\'apiKey=secret-456 .env\'); sys.exit(2)"');
      const payload = broadcastAnalystToolInvoked.mock.calls.at(-1)?.[0] as BroadcastPayload;
      expect(payload.tool).toBe('run_shell_command');
      expect(payload.success).toBe(false);
      expect(payload.summary).not.toMatch(/secret-456|\.env/);
      expect(payload.summary.length).toBeLessThanOrEqual(200);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not expose run_shell_command in telegram tool registration', async () => {
    const root = setupRoot();
    try {
      const handler = new AnalystHandler(root, undefined, undefined, 'analyst', 'telegram');
      expect(handler.getAvailableToolNames()).not.toContain('run_shell_command');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
