import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import type { LlmCallFn } from '../../src/agents/llm-contracts.js';
import { createPlannerContract } from '../../src/contracts/planner-contract.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import type { AgentMessage, CardRecord } from '../../src/schemas/types.js';
import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';

function minimalConfig(): SaivageConfig {
  return {
    models: {
      default: ['test-provider/test-model'],
      executor: ['test-provider/test-model'],
      planner: ['test-provider/test-model'],
      reviewer: ['test-provider/test-model'],
    },
    providers: {
      'test-provider': {
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'test-key',
      },
    },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      candidateAvailabilityCompactBytes: 262144,
      recoverAgentInvocations: true,
      healthCheckIntervalMs: 30000,
      idleShutdownMs: 300000,
      maxGoalDepth: 5,
      recoveryDelayMs: 60000,
      autoDispatchBacklog: true,
      continuousImprovement: false,
      maxReviewRetries: 3,
      processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 },
      compactionThreshold: 0.8,
      maxCompactions: 3,
      compactionTimeoutMs: 1200000,
      compactionKeepFraction: 0.2,
      maxRecoveryRetries: 3,
    },
    security: { injectionScanner: true, maxScanLengthBytes: 102400 },
    supervisor: { enabled: true, intervalMs: 1200000, consecutiveStuckVerdicts: 3, logLines: 400 },
  };
}

function makeCard(overrides: Partial<CardRecord> & { type: CardRecord['type']; title: string }): Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'version_seq' | 'position'> & { id?: string } {
  const lifecycle = overrides.lifecycle ?? ({ status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null } as CardRecord['lifecycle']);
  return {
    parent: 'project',
    depth: 1,
    description: '',
    status: 'backlog',
    subtype: null,
    instructions_file: null,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    assigned_to: null,
    depends_on: [],
    related: [],
    acceptance: '',
    lifecycle,
    metrics: null,
    artifacts: [],
    attachments: [],
    estimate: null,
    started_at: null,
    duration_ms: null,
    status_text: null,
    status_text_updated_at: null,
    status_text_author_session_id: null,
    latest_self_report: null,
    retries: 0,
    ...overrides,
  };
}

describe('AgentAdapter planner-control reviewer prompt contract', () => {
  let tmpDir: string;
  let store: CardStore;
  let adapter: AgentAdapter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-agent-adapter-reviewer-prompt-'));
    initProjectTree(tmpDir);
    const config = minimalConfig();
    writeFileSync(join(tmpDir, '.saivage', 'saivage.json'), JSON.stringify(config, null, 2), 'utf-8');
    store = new CardStore(tmpDir);
    adapter = new AgentAdapter({ projectRoot: tmpDir, saivageDir: join(tmpDir, '.saivage'), config, cardStore: store });
    jest.spyOn(adapter.router, 'resolve').mockResolvedValue([{ provider: 'test-provider', model: 'test-model', account: 'default' }]);
    jest.spyOn(adapter.candidateAvailability, 'isAvailable').mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not invoke a reviewer from planner-control report_goal_done', async () => {
    const goal = store.create(makeCard({
      type: 'goal',
      title: 'Adopt reviewer prompt contract',
      status: 'running',
      acceptance: 'Reviewer prompt must request the canonical envelope.',
    }));
    const evidence = store.create(makeCard({
      type: 'code',
      title: 'Evidence implementation',
      parent: goal.id,
      depth: 2,
      status: 'done',
      lifecycle: { status: 'done', result: { kind: 'executor_success', executor: { summary: 'Implemented reviewer prompt wiring.' }, generated_files: [], verified_at: '2026-01-01T00:00:00.000Z', latest_self_report: { result: 'done', outcome: 'done', summary: 'Implemented reviewer prompt wiring.', status_text: 'done', at: '2026-01-01T00:00:00.000Z' }, warnings: [] }, error: null, completed_at: '2026-01-01T00:00:00.000Z' },
    }));

    const plannerReport = {
      goalId: goal.id,
      status_text: 'Reviewer prompt contract adopted',
      summary: 'Planner terminal report for acceptance review.',
      evidence_card_ids: [evidence.id],
      report: { changed_files: ['src/agents/agent-adapter.ts'], validation: 'focused tests pass' },
    };
    const llmCalls: Array<{ systemPrompt: string; messages: AgentMessage[]; sessionId: string }> = [];
    const llmCallFn: LlmCallFn = async (_candidate, systemPrompt, messages, sessionId) => {
      llmCalls.push({ systemPrompt, messages, sessionId });
      if (sessionId === `planner:${goal.id}` && llmCalls.filter((call) => call.sessionId === sessionId).length === 1) {
        return {
          kind: 'tool_calls',
          tool_calls: [{ id: 'call-report-goal-done', type: 'function', function: { name: 'report_goal_done', arguments: JSON.stringify(plannerReport) } }],
        };
      }
      throw new Error(`unexpected LLM call for session ${sessionId}`);
    };
    const adapterWithLlm = new AgentAdapter({
      projectRoot: tmpDir,
      saivageDir: join(tmpDir, '.saivage'),
      config: minimalConfig(),
      cardStore: store,
      llmCallFn,
    });
    jest.spyOn(adapterWithLlm.router, 'resolve').mockResolvedValue([{ provider: 'test-provider', model: 'test-model', account: 'default' }]);
    jest.spyOn(adapterWithLlm.candidateAvailability, 'isAvailable').mockReturnValue(true);

    const result = await adapterWithLlm.invokePlanner({
      goalId: goal.id,
      systemPrompt: 'planner-system-prompt',
      contextMessages: [],
      contract: createPlannerContract(),
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'done',
      summary: `report_goal_done accepted for goal ${goal.id}.`,
    }));
    expect(llmCalls.filter((call) => call.sessionId === `planner:${goal.id}`)).toHaveLength(1);
    expect(llmCalls.some((call) => call.sessionId.startsWith(`reviewer:${goal.id}:`))).toBe(false);
    expect(store.read(goal.id)?.status).toBe('running');
    expect(store.read(goal.id)?.lifecycle).toEqual({
      status: 'running',
      result: { kind: 'planner_done', summary: 'Planner terminal report for acceptance review.' },
      error: null,
      completed_at: null,
    });
  });
});
