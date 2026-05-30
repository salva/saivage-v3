import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { FakeAgentAdapter, type FakeAgentFixture } from '../../src/agents/fake-agent.js';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import type { AgentExecutionPort as AgentRuntime } from '../../src/contracts/index.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import type { PlannerResult } from '../../src/contracts/index.js';
import { getSessionMessages, listSessions } from '../../src/agents/session-persistence.js';

function assertAgentRuntime(rt: AgentRuntime): AgentRuntime { return rt; }
function makeFixtureDir(tmpDir: string): string { const dir = join(tmpDir, 'fixtures'); mkdirSync(dir, { recursive: true }); return dir; }
function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void { writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8'); }
function writeMinimalConfig(tmpDir: string): void {
  const config: SaivageConfig = {
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
    runtime: { candidateAvailabilityCompactBytes: 262144, recoverAgentInvocations: true, healthCheckIntervalMs: 30000, idleShutdownMs: 300000, maxGoalDepth: 5, recoveryDelayMs: 60000, autoDispatchBacklog: true, continuousImprovement: false, maxReviewRetries: 3, processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 }, compactionThreshold: 0.8, maxCompactions: 3, compactionTimeoutMs: 1200000, compactionKeepFraction: 0.2, maxRecoveryRetries: 3, maxToolTurns: 16, selfCheck: { executor: 15, planner: 30, analyst: 0 } },
    security: { injectionScanner: true, maxScanLengthBytes: 102400 },
    supervisor: { enabled: true, intervalMs: 1200000, consecutiveStuckVerdicts: 3, logLines: 400 },
  };
  writeFileSync(join(tmpDir, '.saivage', 'saivage.json'), JSON.stringify(config, null, 2), 'utf-8');
}
function createMinimalAdapter(tmpDir: string): AgentAdapter {
  writeMinimalConfig(tmpDir);
  const configRaw = readFileSync(join(tmpDir, '.saivage', 'saivage.json'), 'utf-8');
  const config = JSON.parse(configRaw) as SaivageConfig;
  return new AgentAdapter({ projectRoot: tmpDir, saivageDir: join(tmpDir, '.saivage'), config });
}

describe('AgentRuntime Interface', () => {
  let tmpDir: string;
  let fixtureDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'saivage-art-')); fixtureDir = makeFixtureDir(tmpDir); initProjectTree(tmpDir); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  describe('FakeAgentAdapter implements AgentRuntime', () => {
    it('satisfies AgentRuntime interface at the type level', () => {
      const fixture: FakeAgentFixture = { name: 'test-goal', planner: [{ created_cards: [], status: 'continue' }], executor: {}, reviewer: [] };
      writeFixture(fixtureDir, 'test-goal', fixture);
      const adapter = new FakeAgentAdapter({ mapping: { 'goal-1': 'test-goal', '*': 'test-goal' }, fixtureDir });
      const rt: AgentRuntime = assertAgentRuntime(adapter);
      expect(rt).toBe(adapter);
    });

    it('invokePlanner returns PlannerResult (AgentRuntime signature)', () => {
      const fixture: FakeAgentFixture = { name: 'test-goal', planner: [{ created_cards: [{ id: 'code-test-1', type: 'code', title: 'Test card', description: 'A test card', status: 'backlog', depends_on: [], priority: 1 }], updated_cards: [], status: 'continue' }], executor: {}, reviewer: [] };
      writeFixture(fixtureDir, 'test-goal', fixture);
      const adapter = new FakeAgentAdapter({ mapping: { 'goal-1': 'test-goal', '*': 'test-goal' }, fixtureDir });
      const result = adapter.invokePlanner('goal-1', 'system prompt', []);
      const pr: PlannerResult = result;
      expect(pr.created_cards).toHaveLength(1);
      expect(pr.created_cards[0].id).toBe('code-test-1');
      expect(pr.created_cards[0].type).toBe('code');
      expect(pr.created_cards[0].title).toBe('Test card');
      expect(pr.status).toBe('continue');
    });

    it('invokeExecutor returns ExecutorResult (AgentRuntime signature)', () => {
      const fixture: FakeAgentFixture = { name: 'test-goal', planner: [], executor: { 'code-test-1': { card_id: 'code-test-1', status: 'done', status_text: 'Completed test work', artifacts: [{ sourceFile: 'src/test.ts', type: 'data', description: 'Test source file', retain: true }] } }, reviewer: [] };
      writeFixture(fixtureDir, 'test-goal', fixture);
      const adapter = new FakeAgentAdapter({ mapping: { 'goal-1': 'test-goal', '*': 'test-goal' }, fixtureDir });
      const result = adapter.invokeExecutor('code-test-1', 'goal-1', 'system prompt', []);
      expect(result.card_id).toBe('code-test-1');
      expect(result.status).toBe('done');
      expect(result.status_text).toBe('Completed test work');
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].type).toBe('data');
      expect(result.artifacts[0].description).toBe('Test source file');
      expect(result.artifacts[0].retain).toBe(true);
    });

    it('invokeReviewer returns ReviewerResult (AgentRuntime signature)', () => {
      const fixture: FakeAgentFixture = { name: 'test-goal', planner: [], executor: {}, reviewer: [{ assessment: { id: 'review-test-1', goal_card_id: 'goal-1', reviewer_session_id: 'rev-session', assessment_id: 'assessment-test', at: '2025-01-01T00:00:00.000Z', result: 'pass', summary: 'All good.', achieved: ['All criteria met'], issues: [], evidence_card_ids: ['code-test-1'], created_at: new Date().toISOString() } }] };
      writeFixture(fixtureDir, 'test-goal', fixture);
      const adapter = new FakeAgentAdapter({ mapping: { 'goal-1': 'test-goal', '*': 'test-goal' }, fixtureDir });
      const result = adapter.invokeReviewer('goal-1', 'system prompt', []);
      expect(result.assessment.result).toBe('pass');
      expect(result.assessment.summary).toBe('All good.');
      expect(result.assessment.achieved).toEqual(['All criteria met']);
      expect(result.assessment.issues).toEqual([]);
      expect(result.assessment.evidence_card_ids).toEqual(['code-test-1']);
    });

    it('returns canonical planner results on repeated invocations', () => {
      const fixture: FakeAgentFixture = { name: 'test-goal', planner: [{ created_cards: [], status: 'done' }, { created_cards: [], status: 'continue' }], executor: {}, reviewer: [] };
      writeFixture(fixtureDir, 'test-goal', fixture);
      const adapter = new FakeAgentAdapter({ mapping: { 'goal-1': 'test-goal', '*': 'test-goal' }, fixtureDir });
      const rawResult = adapter.invokePlanner('goal-1');
      expect(rawResult.status).toBe('done');
      const interfaceResult = adapter.invokePlanner('goal-1', 'prompt', []);
      expect(interfaceResult.status).toBe('continue');
    });
  });

  describe('AgentAdapter implements AgentRuntime', () => {
    it('satisfies AgentRuntime interface at the type level', () => {
      const adapter = createMinimalAdapter(tmpDir);
      const rt: AgentRuntime = assertAgentRuntime(adapter);
      expect(rt).toBe(adapter);
    });

    it('AgentAdapter has invokePlanner method matching the interface', () => {
      const adapter = createMinimalAdapter(tmpDir);
      expect(typeof adapter.invokePlanner).toBe('function');
    });

    it('AgentAdapter has invokeExecutor method matching the interface', () => {
      const adapter = createMinimalAdapter(tmpDir);
      expect(typeof adapter.invokeExecutor).toBe('function');
    });

    it('AgentAdapter has invokeReviewer method matching the interface', () => {
      const adapter = createMinimalAdapter(tmpDir);
      expect(typeof adapter.invokeReviewer).toBe('function');
    });
  });
});
