import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { AnalystHandler } = await import('../../src/agents/analyst-handler.js');

type FetchCall = { url: string; init: RequestInit; body: Record<string, unknown> };

const PROVIDER_URL = 'http://test-provider.invalid/v1/chat/completions';
const TEST_MODEL = 'test-analyst-model';

function setupRoot(analystModels: string[] = [TEST_MODEL]): string {
  const root = mkdtempSync(join(tmpdir(), 's01-analyst-llm-'));
  const sd = join(root, '.saivage');
  for (const d of ['cards/by-id', 'cards/tree', 'cards/dependencies', 'notes/by-card', 'runtime', 'agents/sessions', 'agents/messages']) mkdirSync(join(sd, d), { recursive: true });
  writeConfig(root, analystModels);
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  return root;
}

function writeConfig(root: string, analystModels: string[]): void {
  writeFileSync(join(root, '.saivage', 'saivage.json'), JSON.stringify({
    models: { analyst: analystModels },
    providers: { test: { models: [TEST_MODEL], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
  }, null, 2));
}

function successResponse(content: string): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: TEST_MODEL,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function mockContentResponses(...contents: string[]): jest.SpiedFunction<typeof fetch> {
  let index = 0;
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const content = contents[Math.min(index, contents.length - 1)] ?? 'ok';
    index += 1;
    return successResponse(content);
  });
}

function fetchCalls(spy: jest.SpiedFunction<typeof fetch>): FetchCall[] {
  return spy.mock.calls.map(([url, init]) => ({
    url: String(url),
    init: init as RequestInit,
    body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
  }));
}

function readPersistedAssistant(root: string, sessionId: string): string[] {
  const raw = readFileSync(join(root, '.saivage', 'agents', 'messages', `${sessionId}.jsonl`), 'utf-8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { role: string; kind: string; content: string })
    .filter((message) => message.role === 'assistant' && message.kind === 'text')
    .map((message) => message.content);
}

describe('LlmIntentResolver analyst integration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('issues a real LLM POST per turn', async () => {
    const root = setupRoot();
    try {
      const spy = mockContentResponses('Here are your cards.');
      const handler = new AnalystHandler(root);
      await handler.handleMessage('s-real-post', 'list my cards');
      const calls = fetchCalls(spy);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(PROVIDER_URL);
      expect(calls[0].init.method).toBe('POST');
      expect(calls[0].body.model).toBe(TEST_MODEL);
      const messages = calls[0].body.messages as Array<{ role: string; content: string }>;
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('You are the Saivage Analyst');
      expect((calls[0].body.tools as unknown[]).length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns analyst is offline when models.analyst is empty', async () => {
    const root = setupRoot([]);
    try {
      const spy = jest.spyOn(globalThis, 'fetch');
      const handler = new AnalystHandler(root);
      const response = await handler.handleMessage('s-no-candidate', 'list my cards');
      expect(response.message.content).toContain('analyst is offline');
      expect(response.toolInvocations ?? []).toHaveLength(0);
      expect(spy).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns analyst is offline when every candidate fails auth', async () => {
    const root = setupRoot();
    try {
      const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
      const handler = new AnalystHandler(root);
      const response = await handler.handleMessage('s-auth-failed', 'list my cards');
      expect(response.message.content).toContain('analyst is offline');
      expect(response.toolInvocations ?? []).toHaveLength(0);
      const calls = fetchCalls(spy);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(PROVIDER_URL);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('forwards the immediately prior user and assistant turns', async () => {
    const root = setupRoot();
    try {
      const spy = mockContentResponses('Goal goal-7 is visible.', 'Which following item did you mean?');
      const handler = new AnalystHandler(root);
      await handler.handleMessage('s-context', 'show me goal-7');
      await handler.handleMessage('s-context', 'and the one after it');
      const secondBody = fetchCalls(spy)[1].body;
      const messages = secondBody.messages as Array<{ role: string; content: string }>;
      const contents = messages.map((message) => message.content);
      const turn1User = contents.indexOf('show me goal-7');
      const turn1Assistant = contents.indexOf('Goal goal-7 is visible.');
      const turn2User = contents.indexOf('and the one after it');
      expect(turn1User).toBeGreaterThan(-1);
      expect(turn1Assistant).toBeGreaterThan(turn1User);
      expect(turn2User).toBeGreaterThan(turn1Assistant);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not invoke a tool when the LLM returns content only', async () => {
    const root = setupRoot();
    try {
      const clarification = 'Which cancelled cards should I delete?';
      mockContentResponses(clarification);
      const handler = new AnalystHandler(root);
      const response = await handler.handleMessage('s-content-only', 'delete the cancelled cards');
      expect(response.toolInvocations ?? []).toHaveLength(0);
      expect(response.message.content).toBe(clarification);
      expect(readPersistedAssistant(root, 's-content-only')).toContain(clarification);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
