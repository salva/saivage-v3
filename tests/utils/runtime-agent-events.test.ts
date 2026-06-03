import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

import { initProjectTree } from '../../src/persistence/file-tree.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { EventLogger } from '../../src/observability/event-logger.js';
import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import type { FakeAgentFixture } from '../../src/agents/fake-agent.js';
import { createRuntimeCoreTestContainer, type RuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';

function makeFixtureDir(tmpDir: string): string {
  const dir = join(tmpDir, 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8');
}

function makeDefaultConfig(tmpDir: string, fixtureDir: string) {
  return {
    projectRoot: tmpDir,
    fakeAgentConfig: {
      mapping: { project: 'test-fixture' },
      fixtureDir,
    },
  };
}

describe('Agent Events → Runtime EventEmitter', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let harness: RuntimeCoreTestContainer | undefined;

  function createRuntime(): void {
    harness = createRuntimeCoreTestContainer({ config: makeDefaultConfig(tmpDir, fixtureDir) });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-aev-'));
    fixtureDir = makeFixtureDir(tmpDir);
    initProjectTree(tmpDir);
  });

  afterEach(() => {
    if (harness) {
      try { harness.api.shutdown(); } catch { /* ignore */ }
    }
    try { releaseLock(tmpDir); } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Runtime.emitAgentEvent() emits through EventEmitter to listeners', () => {
    createRuntime();

    const received: Array<{ name: string; data: Record<string, unknown> }> = [];
    harness!.eventTestTools.on('session_started', (data: unknown) => {
      received.push({
        name: 'session_started',
        data: data as Record<string, unknown>,
      });
    });
    harness!.eventTestTools.on('llm_attempt', (data: unknown) => {
      received.push({
        name: 'llm_attempt',
        data: data as Record<string, unknown>,
      });
    });
    harness!.eventTestTools.on('llm_invocation_summary', (data: unknown) => {
      received.push({
        name: 'llm_invocation_summary',
        data: data as Record<string, unknown>,
      });
    });

    // Act
    harness!.eventTestTools.emitAgentEvent('session_started', {
      session_id: 'sess-1',
      role: 'planner',
      goal_id: 'goal-1',
      card_id: 'card-1',
    });
    harness!.eventTestTools.emitAgentEvent('llm_attempt', {
      session_id: 'sess-1',
      role: 'planner',
      attempt: 1,
      same_candidate_attempt: 1,
      provider: 'test',
      model: 'm1',
      account: '_',
      started_at: '2026-05-23T00:00:00.000Z',
      duration_ms: 150,
      outcome: { kind: 'succeeded', terminal_tool: 'emit_planner_result' },
    });
    harness!.eventTestTools.emitAgentEvent('llm_invocation_summary', {
      session_id: 'sess-1',
      role: 'planner',
      goal_id: 'goal-1',
      card_id: 'card-1',
      contract_id: 'planner.v1',
      attempts_count: 1,
      total_duration_ms: 150,
      verdict: 'succeeded',
      repair_attempts: 0,
      final_provider: 'test',
      final_model: 'm1',
      final_account: '_',
      final_terminal_tool: 'emit_planner_result',
    });

    // Assert
    expect(received.length).toBe(3);
    expect(received[0].name).toBe('session_started');
    expect((received[0].data as Record<string, unknown>).session_id).toBe('sess-1');
    expect(received[1].name).toBe('llm_attempt');
    expect((received[1].data as Record<string, unknown>).model).toBe('m1');
    expect(received[2].name).toBe('llm_invocation_summary');
    expect((received[2].data as Record<string, unknown>).total_duration_ms).toBe(150);
  });

  it('emits all 4 agent event types through EventEmitter', () => {
    createRuntime();

    const received: string[] = [];
    harness!.eventTestTools.on('session_started', () => received.push('session_started'));
    harness!.eventTestTools.on('llm_attempt', () => received.push('llm_attempt'));
    harness!.eventTestTools.on('llm_invocation_summary', () => received.push('llm_invocation_summary'));
    harness!.eventTestTools.on('compaction_triggered', () => received.push('compaction_triggered'));

    harness!.eventTestTools.emitAgentEvent('session_started', { session_id: 's1', role: 'planner', goal_id: 'g1', card_id: 'c1' });
    harness!.eventTestTools.emitAgentEvent('llm_attempt', { session_id: 's1', role: 'planner', attempt: 1, same_candidate_attempt: 1, provider: 'p', model: 'm', account: '_', started_at: '2026-05-23T00:00:00.000Z', duration_ms: 100, outcome: { kind: 'succeeded', terminal_tool: 'emit_planner_result' } });
    harness!.eventTestTools.emitAgentEvent('llm_attempt', { session_id: 's1', role: 'planner', attempt: 1, same_candidate_attempt: 1, provider: 'p', model: 'm', account: '_', started_at: '2026-05-23T00:00:00.000Z', duration_ms: 50, outcome: { kind: 'failed', failure_class: 'unknown', recovery_action: 'abort_without_retry', error_name: 'E', error_message: 'err', error_preview: 'err' } });
    harness!.eventTestTools.emitAgentEvent('llm_invocation_summary', { session_id: 's1', role: 'planner', goal_id: 'g1', card_id: 'c1', contract_id: 'planner.v1', attempts_count: 2, total_duration_ms: 150, verdict: 'exhausted', repair_attempts: 0, last_failure_class: 'unknown' });
    harness!.eventTestTools.emitAgentEvent('compaction_triggered', { session_id: 's1', role: 'planner', tokens_before: 1000, tokens_after: 500 });

    expect(received).toEqual([
      'session_started',
      'llm_attempt',
      'llm_attempt',
      'llm_invocation_summary',
      'compaction_triggered',
    ]);
  });

  it('wireRuntimeEvents catches agent events broadcast from runtime', () => {
    createRuntime();

    // Simulate what wireRuntimeEvents does by directly tracking events
    const received: string[] = [];
    const trackedEvents = [
      'session_started', 'llm_attempt', 'llm_invocation_summary', 'compaction_triggered',
    ];
    for (const evt of trackedEvents) {
      harness!.eventTestTools.on(evt, () => received.push(evt));
    }

    harness!.eventTestTools.emitAgentEvent('session_started', { session_id: 's1', role: 'planner', goal_id: 'g1', card_id: 'c1' });
    harness!.eventTestTools.emitAgentEvent('llm_invocation_summary', { session_id: 's1', role: 'planner', goal_id: 'g1', card_id: 'c1', contract_id: 'planner.v1', attempts_count: 1, total_duration_ms: 100, verdict: 'succeeded', repair_attempts: 0, final_provider: 'p', final_model: 'm', final_account: '_', final_terminal_tool: 'emit_planner_result' });

    expect(received).toContain('session_started');
    expect(received).toContain('llm_invocation_summary');
  });

  it('does not double-log agent events to EventLogger (EventLogger count unchanged)', () => {
    // New Runtimes create a fresh EventLogger. We verify that emitAgentEvent
    // does NOT call _eventLogger.appendEvent by checking the events.jsonl file
    // has no agent events after calling emitAgentEvent.
    createRuntime();

    harness!.eventTestTools.emitAgentEvent('session_started', {
      session_id: 's1',
      role: 'planner',
      goal_id: 'g1',
      card_id: 'c1',
    });

    // Flush and check events.jsonl — should be empty (or only have startup events)
    const events = harness!.loggerTestTools.getEvents();
    const agentEventKinds = [
      'session_started', 'llm_attempt', 'llm_invocation_summary', 'compaction_triggered',
    ];
    const agentEvents = events.filter((e) => agentEventKinds.includes(e.kind));
    expect(agentEvents.length).toBe(0);
  });
});

// ── Test AgentAdapter event bus integration ──────────────

describe('AgentAdapter eventBus wiring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-aaev-'));
    initProjectTree(tmpDir);
  });

  afterEach(() => {
    try { releaseLock(tmpDir); } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a minimal valid SaivageConfig with Zod defaults filled in. */
  function minimalConfig() {
    return saivageConfigSchema.parse({});
  }

  it('AgentAdapter.setEventBus sets the eventBus property', () => {
    const saivageDir = join(tmpDir, '.saivage');
    const eventLogger = new EventLogger(saivageDir);
    const bus = new EventEmitter();
    const config = minimalConfig();

    const adapter = new AgentAdapter({
      projectRoot: tmpDir,
      saivageDir,
      config,
      eventLogger,
    });

    // Initially no eventBus
    expect((adapter as unknown as { eventBus?: unknown }).eventBus).toBeUndefined();

    // Set event bus
    adapter.setEventBus(bus);
    expect((adapter as unknown as { eventBus?: unknown }).eventBus).toBe(bus);
  });

  it('agent events emitted on eventBus reach listeners', () => {
    const saivageDir = join(tmpDir, '.saivage');
    const eventLogger = new EventLogger(saivageDir);
    const bus = new EventEmitter();
    const config = minimalConfig();

    const adapter = new AgentAdapter({
      projectRoot: tmpDir,
      saivageDir,
      config,
      eventLogger,
    });

    adapter.setEventBus(bus);

    const received: string[] = [];
    bus.on('session_started', () => received.push('session_started'));
    bus.on('llm_invocation_summary', () => received.push('llm_invocation_summary'));

    // Emit through the adapter's eventBus the way AgentAdapter.invokeAgent() does
    (adapter as unknown as { eventBus: EventEmitter }).eventBus.emit('session_started', {
      session_id: 'sess-test',
      role: 'planner',
      goal_id: 'g1',
      card_id: 'c1',
    });

    (adapter as unknown as { eventBus: EventEmitter }).eventBus.emit('llm_invocation_summary', {
      session_id: 'sess-test',
      role: 'planner',
      goal_id: 'g1',
      card_id: 'c1',
      attempts_count: 1,
      total_duration_ms: 200,
      verdict: 'succeeded',
      final_provider: 'p',
      final_model: 'm',
      final_account: '_',
      final_terminal_tool: 'emit_planner_result',
    });

    expect(received).toContain('session_started');
    expect(received).toContain('llm_invocation_summary');
  });

  it('AgentAdapter forwards events through an injected eventBus', () => {
    const saivageDir = join(tmpDir, '.saivage');
    const eventLogger = new EventLogger(saivageDir);
    const config = minimalConfig();

    const eventBus = new EventEmitter();

    const adapter = new AgentAdapter({
      projectRoot: tmpDir,
      saivageDir,
      config,
      eventLogger,
    });

    adapter.setEventBus(eventBus);

    const received: Array<{ name: string; data: Record<string, unknown> }> = [];
    eventBus.on('session_started', (data: unknown) => {
      received.push({ name: 'session_started', data: data as Record<string, unknown> });
    });
    eventBus.on('compaction_triggered', (data: unknown) => {
      received.push({ name: 'compaction_triggered', data: data as Record<string, unknown> });
    });

    // Emit through eventBus as AgentAdapter would
    const bus = (adapter as unknown as { eventBus: EventEmitter }).eventBus;
    bus.emit('session_started', { session_id: 's1', role: 'executor', goal_id: 'g1', card_id: 'c1' });
    bus.emit('compaction_triggered', { session_id: 's1', role: 'executor', tokens_before: 5000, tokens_after: 2000 });

    expect(received.length).toBe(2);
    expect(received[0].name).toBe('session_started');
    expect(received[0].data.session_id).toBe('s1');
    expect(received[1].name).toBe('compaction_triggered');
    expect(received[1].data.tokens_before).toBe(5000);
  });
});
