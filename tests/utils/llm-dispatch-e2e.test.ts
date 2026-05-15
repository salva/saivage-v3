/**
 * Stage 24 — E2E LLM Dispatch Test
 *
 * Comprehensive integration test that exercises the full real LLM dispatch
 * pipeline: ActiveRuntime → dispatchGoal → skills/instructions → system
 * prompts → LlmClient (mock HTTP server) → result parsing → card state
 * transitions.
 *
 * Validates all the wiring from stages 13-23 works together.
 *
 * AC 1: Mock HTTP server returns valid planner/executor/reviewer responses
 * AC 2: ActiveRuntime dispatches goal through real AgentAdapter + LlmClient
 * AC 3: Mock server records show system prompts include skills and instructions
 * AC 4: Goal completes successfully through the full pipeline
 * AC 5: npm run typecheck passes
 * AC 6: All existing tests pass with zero regressions
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { ActiveRuntime } from '../../src/utils/active-runtime.js';

interface CapturedRequest {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  url: string;
  method: string;
  timestamp: string;
}

interface MockServerHandle {
  server: Server;
  port: number;
  captures: CapturedRequest[];
}

function createMockLlmServer(
  responses: Array<{
    statusCode?: number;
    contentType?: string;
    body: string;
  }>,
): Promise<MockServerHandle> {
  return new Promise((resolve) => {
    const captures: CapturedRequest[] = [];
    let responseIdx = 0;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const cap: CapturedRequest = {
        body: '',
        headers: { ...req.headers },
        url: req.url ?? '',
        method: req.method ?? '',
        timestamp: new Date().toISOString(),
      };

      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        cap.body = body;
        captures.push(cap);

        const resp = responses[responseIdx] ?? responses[responses.length - 1];
        if (responseIdx < responses.length) {
          responseIdx++;
        }

        if (!resp) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No more mock responses configured' }));
          return;
        }

        res.writeHead(resp.statusCode ?? 200, {
          'Content-Type': resp.contentType ?? 'application/json',
        });
        res.end(resp.body);
      });
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, captures });
    });
  });
}

function okResp(content: string, model = 'test-model'): string {
  return JSON.stringify({
    id: 'chatcmpl-e2e-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
}

const PLANNER_RESPONSE_1 = JSON.stringify({
  created_cards: [
    {
      id: 'code-e2e-llm-1',
      type: 'code',
      title: 'Implement LLM dispatch',
      description: 'Implement the LLM dispatch feature',
      status: 'backlog',
      depends_on: [],
      priority: 1,
      tags: ['e2e'],
    },
    {
      id: 'code-e2e-llm-2',
      type: 'test',
      title: 'Test LLM dispatch',
      description: 'Add tests for LLM dispatch',
      status: 'backlog',
      depends_on: ['code-e2e-llm-1'],
      priority: 2,
    },
  ],
  updated_cards: [],
  status: 'continue',
  summary: 'Created two cards for LLM dispatch',
});

const PLANNER_RESPONSE_2 = JSON.stringify({
  created_cards: [],
  updated_cards: [],
  status: 'done',
  summary: 'All work is complete, declaring done',
});

const EXECUTOR_RESPONSE_1 = JSON.stringify({
  card_id: 'code-e2e-llm-1',
  status: 'done',
  result: { message: 'implementation complete' },
  artifacts: [],
  attachments: [],
  summary: 'Implemented the feature',
});

const EXECUTOR_RESPONSE_2 = JSON.stringify({
  card_id: 'code-e2e-llm-2',
  status: 'done',
  result: { tests: 5, passed: 5 },
  artifacts: [],
  attachments: [],
  summary: 'All tests passing',
});

const REVIEWER_RESPONSE = JSON.stringify({
  assessment: {
    result: 'pass',
    summary: 'All criteria met',
    achieved: ['Feature implemented', 'Tests passing'],
    missing: [],
    evidence_card_ids: ['code-e2e-llm-1', 'code-e2e-llm-2'],
  },
});

const PROJECT_PLANNER_RESPONSE_1 = JSON.stringify({
  created_cards: [
    {
      id: 'code-project-evidence-1',
      type: 'code',
      title: 'Produce project evidence',
      description: 'Produce durable evidence for project-level completion',
      status: 'backlog',
      depends_on: [],
      priority: 1,
      tags: ['e2e'],
    },
  ],
  updated_cards: [],
  status: 'continue',
  summary: 'Created project-level evidence card',
});

const PROJECT_EXECUTOR_RESPONSE_1 = JSON.stringify({
  card_id: 'code-project-evidence-1',
  status: 'done',
  result: { evidence: 'project-level evidence complete' },
  artifacts: [],
  attachments: [],
  summary: 'Produced project evidence',
});

const PROJECT_REVIEWER_RESPONSE = JSON.stringify({
  assessment: {
    result: 'pass',
    summary: 'Project-level criteria met',
    achieved: ['Project evidence produced'],
    missing: [],
    evidence_card_ids: ['code-project-evidence-1'],
  },
});

const SKILL_CONTENT = `# E2E Skill
This skill tests that skills are injected into system prompts during LLM dispatch.`;

const DEFAULT_PLANNER_INSTRUCTIONS = `# Default Planner Instructions
These are the default instructions for all depth-0 planners wiring test.`;

const CUSTOM_PLANNER_INSTRUCTIONS = `# Custom Goal Instructions
These are per-goal instructions for depth > 0 goals.`;

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `saivage-e2e-llm-${Date.now()}-${randomBytes(4).toString('hex')}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function setupProject(projectRoot: string, mockPort: number): void {
  initProjectTree(projectRoot);

  const sd = join(projectRoot, '.saivage');
  const now = new Date().toISOString();

  writeFileSync(
    join(sd, 'saivage.json'),
    JSON.stringify(
      {
        server: { port: 8080, host: '127.0.0.1' },
        models: {
          planner: ['test-model'],
          executor: ['test-model'],
          reviewer: ['test-model'],
          default: ['test-model'],
        },
        providers: {
          'e2e-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: `http://localhost:${mockPort}`,
            apiKey: 'sk-e2e-test-key',
          },
        },
        runtime: {
          autoDispatchBacklog: false,
          recoveryDelayMs: 10,
          maxRecoveryRetries: 0,
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  writeFileSync(
    join(sd, 'skills', 'index.json'),
    JSON.stringify(
      [
        {
          name: 'e2e-test-skill',
          file: 'e2e-test-skill.md',
          target_agents: ['planner', 'executor', 'reviewer'],
          triggers: [{ type: 'keyword', pattern: 'LLM dispatch' }],
          updated_at: now,
        },
      ],
      null,
      2,
    ),
    'utf-8',
  );

  writeFileSync(join(sd, 'skills', 'e2e-test-skill.md'), SKILL_CONTENT, 'utf-8');

  mkdirSync(join(sd, 'instructions'), { recursive: true });
  writeFileSync(
    join(sd, 'instructions', 'planner.md'),
    DEFAULT_PLANNER_INSTRUCTIONS,
    'utf-8',
  );

  writeFileSync(
    join(sd, 'instructions', 'executor.md'),
    '# Executor Instructions\nExecutor default instructions for e2e tests.',
    'utf-8',
  );

  writeFileSync(
    join(sd, 'instructions', 'reviewer.md'),
    '# Reviewer Instructions\nReviewer default instructions for e2e tests.',
    'utf-8',
  );

  writeFileSync(
    join(projectRoot, 'e2e-custom-instructions.md'),
    CUSTOM_PLANNER_INSTRUCTIONS,
    'utf-8',
  );
}

describe('E2E LLM Dispatch Pipeline', () => {
  let tmpDir: string;
  let mock: MockServerHandle | null = null;

  afterEach(async () => {
    if (mock) {
      await new Promise<void>((resolve) => mock!.server.close(() => resolve()));
      mock = null;
    }
    if (tmpDir) cleanupDir(tmpDir);
    tmpDir = '';
  });

  it('should dispatch a depth-1 goal with custom instructions_file through the full LLM pipeline', async () => {
    mock = await createMockLlmServer([
      { body: okResp(PLANNER_RESPONSE_1) },
      { body: okResp(EXECUTOR_RESPONSE_1) },
      { body: okResp(EXECUTOR_RESPONSE_2) },
      { body: okResp(PLANNER_RESPONSE_2) },
      { body: okResp(REVIEWER_RESPONSE) },
    ]);

    tmpDir = makeTempDir();
    setupProject(tmpDir, mock.port);

    const { CardStore } = await import('../../src/utils/card-store.js');
    const store = new CardStore(tmpDir);
    store.create({
      id: 'e2e-llm-goal',
      type: 'goal',
      parent: 'project',
      depth: 1,
      title: 'E2E LLM Dispatch Goal',
      description: 'Test the full LLM dispatch pipeline end to end',
      status: 'backlog',
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: 'Goal completes successfully through the full pipeline',
      artifacts: [],
      attachments: [],
      retries: 0,
      instructions_file: 'e2e-custom-instructions.md',
    });

    const activeRuntime = new ActiveRuntime(tmpDir);
    await activeRuntime.start();

    let goalCompleted = false;
    activeRuntime.runtime.on('goal_completed', () => {
      goalCompleted = true;
    });

    await activeRuntime.dispatchGoal('e2e-llm-goal');
    await activeRuntime.stop();

    expect(goalCompleted).toBe(true);
    const finalGoal = store.read('e2e-llm-goal');
    expect(finalGoal).not.toBeNull();
    expect(finalGoal!.status).toBe('done');

    const card1 = store.read('code-e2e-llm-1');
    expect(card1).not.toBeNull();
    expect(card1!.status).toBe('done');

    const card2 = store.read('code-e2e-llm-2');
    expect(card2).not.toBeNull();
    expect(card2!.status).toBe('done');

    expect(mock.captures.length).toBe(5);

    for (const cap of mock.captures) {
      expect(cap.method).toBe('POST');
      expect(cap.url).toBe('/v1/chat/completions');
      expect(cap.headers['content-type']).toBe('application/json');
      expect(cap.headers['authorization']).toBe('Bearer sk-e2e-test-key');

      const parsed = JSON.parse(cap.body);
      expect(parsed.model).toBe('test-model');
      expect(parsed.messages).toBeDefined();
      expect(Array.isArray(parsed.messages)).toBe(true);
      expect(parsed.messages.length).toBeGreaterThan(0);
    }

    const plannerReq1 = JSON.parse(mock.captures[0].body);
    const systemMsg = plannerReq1.messages[0];
    expect(systemMsg.role).toBe('system');

    expect(systemMsg.content).toContain('--- SKILL: e2e-test-skill ---');
    expect(systemMsg.content).toContain('--- END SKILL ---');
    expect(systemMsg.content).toContain(
      'This skill tests that skills are injected into system prompts',
    );

    expect(systemMsg.content).toContain('--- PLANNER INSTRUCTIONS ---');
    expect(systemMsg.content).toContain('--- END PLANNER INSTRUCTIONS ---');
    expect(systemMsg.content).toContain('Custom Goal Instructions');
    expect(systemMsg.content).toContain('per-goal instructions for depth > 0 goals');
    expect(systemMsg.content).not.toContain('default instructions for all depth-0 planners');

    const plannerReq2 = JSON.parse(mock.captures[3].body);
    const systemMsg2 = plannerReq2.messages[0];
    expect(systemMsg2.role).toBe('system');
    expect(systemMsg2.content).toContain('--- SKILL: e2e-test-skill ---');
    expect(systemMsg2.content).toContain('--- PLANNER INSTRUCTIONS ---');
    expect(systemMsg2.content).toContain('Custom Goal Instructions');
    expect(systemMsg2.content).not.toContain('default instructions for all depth-0 planners');

    const execReq1 = JSON.parse(mock.captures[1].body);
    const execSysMsg = execReq1.messages[0];
    expect(execSysMsg.role).toBe('system');
    expect(execSysMsg.content).toContain('Executor default instructions for e2e tests');
    expect(execSysMsg.content).toContain('--- SKILL: e2e-test-skill ---');

    const reviewerReq = JSON.parse(mock.captures[4].body);
    const revSysMsg = reviewerReq.messages[0];
    expect(revSysMsg.role).toBe('system');
    expect(revSysMsg.content).toContain('Reviewer default instructions for e2e tests');
    expect(revSysMsg.content).toContain('--- SKILL: e2e-test-skill ---');
  });

  it('mock server should return valid OpenAI-compatible responses', async () => {
    const testMock = await createMockLlmServer([
      { body: okResp(PLANNER_RESPONSE_1) },
    ]);

    try {
      const resp = await fetch(
        `http://localhost:${testMock.port}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'test-model',
            messages: [{ role: 'user', content: 'test' }],
            temperature: 0.7,
            max_tokens: 4096,
            stream: false,
          }),
        },
      );

      expect(resp.ok).toBe(true);
      const body = await resp.json();

      expect(body.id).toBeDefined();
      expect(body.object).toBe('chat.completion');
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].message).toBeDefined();
      expect(body.choices[0].message.content).toBeDefined();
      expect(body.choices[0].finish_reason).toBe('stop');

      const innerJson = JSON.parse(body.choices[0].message.content);
      expect(innerJson.created_cards).toBeDefined();
      expect(innerJson.created_cards).toHaveLength(2);
      expect(innerJson.status).toBe('continue');

      expect(testMock.captures.length).toBe(1);
      expect(testMock.captures[0].method).toBe('POST');
      expect(testMock.captures[0].url).toBe('/v1/chat/completions');
    } finally {
      await new Promise<void>((resolve) =>
        testMock.server.close(() => resolve()),
      );
    }
  });

  it('project card (depth 0) should use default planner instructions', async () => {
    mock = await createMockLlmServer([
      { body: okResp(PROJECT_PLANNER_RESPONSE_1) },
      { body: okResp(PROJECT_EXECUTOR_RESPONSE_1) },
      { body: okResp(PLANNER_RESPONSE_2) },
      { body: okResp(PROJECT_REVIEWER_RESPONSE) },
    ]);

    tmpDir = makeTempDir();
    setupProject(tmpDir, mock.port);

    const activeRuntime = new ActiveRuntime(tmpDir);
    await activeRuntime.start();

    let goalCompleted = false;
    activeRuntime.runtime.on('goal_completed', () => {
      goalCompleted = true;
    });

    await activeRuntime.dispatchGoal('project');
    await activeRuntime.stop();

    expect(goalCompleted).toBe(true);

    const { CardStore } = await import('../../src/utils/card-store.js');
    const store = new CardStore(tmpDir);
    const projectCard = store.read('project');
    expect(projectCard!.status).toBe('done');

    expect(mock.captures.length).toBeGreaterThanOrEqual(1);
    const plannerReq = JSON.parse(mock.captures[0].body);
    const systemMsg = plannerReq.messages[0];

    expect(systemMsg.content).toContain('--- PLANNER INSTRUCTIONS ---');
    expect(systemMsg.content).toContain(
      'default instructions for all depth-0 planners',
    );
    expect(systemMsg.content).not.toContain(
      'per-goal instructions for depth > 0 goals',
    );
  });
});
