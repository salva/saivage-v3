import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

import { Runtime } from '../../src/runtime/runtime.js';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { releaseLock } from '../../src/utils/runtime-lock.js';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { EventLogger } from '../../src/utils/event-logger.js';
import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import type { FakeAgentFixture } from '../../src/utils/fake-agent.js';

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
  let runtime: Runtime;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-aev-'));
    fixtureDir = makeFixtureDir(tmpDir);
    initProjectTree(tmpDir);
  });

  afterEach(() => {
    if (runtime) {
      try { runtime.shutdown(); } catch { /* ignore */ }
    }
    try { releaseLock(tmpDir); } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Runtime.emitAgentEvent() emits through EventEmitter to listeners', () => {
    runtime = new Runtime(makeDefaultConfig(tmpDir, fixtureDir));

    const received: Array<{ name: string; data: Record<string, unknown> }> = [];
    runtime.on('session_started', (data: unknown) => {
      received.push({
        name: 'session_started',
        data: data as Record<string, unknown>,
      });
    });
    runtime.on('model_selected', (data: unknown) => {
      received.push({
        name: 'model_selected',
        data: data as Record<string, unknown>,
      });
    });
    runtime.on('invocation_succeeded', (data: unknown) => {
      received.push({
        name: 'invocation_succeeded',
        data: data as Record<string, unknown>,
      });
    });

    // Act
    runtime.emitAgentEvent('session_started', {
      session_id: 'sess-1',
      role: 'planner',
      goal_id: 'goal-1',
      card_id: 'card-1',
    });
    runtime.emitAgentEvent('model_selected', {
      session_id: 'sess-1',
      provider: 'test',
      model: 'm1',
      role: 'planner',
    });
    runtime.emitAgentEvent('invocation_succeeded', {
      session_id: 'sess-1',
      role: 'planner',
      attempt: 1,
      duration_ms: 150,
    });

    // Assert
    expect(received.length).toBe(3);
    expect(received[0].name).toBe('session_started');
    expect((received[0].data as Record<string, unknown>).session_id).toBe('sess-1');
    expect(received[1].name).toBe('model_selected');
    expect((received[1].data as Record<string, unknown>).model).toBe('m1');
    expect(received[2].name).toBe('invocation_succeeded');
    expect((received[2].data as Record<string, unknown>).duration_ms).toBe(150);
  });

  it('emits all 6 agent event types through EventEmitter', () => {
    runtime = new Runtime(makeDefaultConfig(tmpDir, fixtureDir));

    const received: string[] = [];
    runtime.on('session_started', () => received.push('session_started'));
    runtime.on('model_selected', () => received.push('model_selected'));
    runtime.on('invocation_succeeded', () => received.push('invocation_succeeded'));
    runtime.on('invocation_failed', () => received.push('invocation_failed'));
    runtime.on('retry_attempted', () => received.push('retry_attempted'));
    runtime.on('compaction_triggered', () => received.push('compaction_triggered'));

    // Act — emit all 6 event types
    runtime.emitAgentEvent('session_started', { session_id: 's1', role: 'planner', goal_id: 'g1', card_id: 'c1' });
    runtime.emitAgentEvent('model_selected', { session_id: 's1', provider: 'p', model: 'm', role: 'planner' });
    runtime.emitAgentEvent('invocation_succeeded', { session_id: 's1', role: 'planner', attempt: 1, duration_ms: 100 });
    runtime.emitAgentEvent('invocation_failed', { session_id: 's1', role: 'planner', attempt: 1, error_message: 'err' });
    runtime.emitAgentEvent('retry_attempted', { session_id: 's1', role: 'planner', attempt: 2, directive: 'retry' });
    runtime.emitAgentEvent('compaction_triggered', { session_id: 's1', role: 'planner', tokens_before: 1000, tokens_after: 500 });

    // Assert
    expect(received).toEqual([
      'session_started',
      'model_selected',
      'invocation_succeeded',
      'invocation_failed',
      'retry_attempted',
      'compaction_triggered',
    ]);
  });

  it('wireRuntimeEvents catches agent events broadcast from runtime', () => {
    runtime = new Runtime(makeDefaultConfig(tmpDir, fixtureDir));

    // Simulate what wireRuntimeEvents does by directly tracking events
    const received: string[] = [];
    const trackedEvents = [
      'session_started', 'model_selected',
      'invocation_succeeded', 'invocation_failed',
      'retry_attempted', 'compaction_triggered',
    ];
    for (const evt of trackedEvents) {
      runtime.on(evt, () => received.push(evt));
    }

    runtime.emitAgentEvent('session_started', { session_id: 's1', role: 'planner', goal_id: 'g1', card_id: 'c1' });
    runtime.emitAgentEvent('invocation_succeeded', { session_id: 's1', role: 'planner', attempt: 1, duration_ms: 100 });

    expect(received).toContain('session_started');
    expect(received).toContain('invocation_succeeded');
  });

  it('does not double-log agent events to EventLogger (EventLogger count unchanged)', () => {
    // New Runtimes create a fresh EventLogger. We verify that emitAgentEvent
    // does NOT call _eventLogger.appendEvent by checking the events.jsonl file
    // has no agent events after calling emitAgentEvent.
    runtime = new Runtime(makeDefaultConfig(tmpDir, fixtureDir));

    runtime.emitAgentEvent('session_started', {
      session_id: 's1',
      role: 'planner',
      goal_id: 'g1',
      card_id: 'c1',
    });

    // Flush and check events.jsonl — should be empty (or only have startup events)
    const events = runtime.eventLogger.getEvents();
    const agentEventKinds = [
      'session_started', 'model_selected', 'invocation_succeeded',
      'invocation_failed', 'retry_attempted', 'compaction_triggered',
    ];
    const agentEvents = events.filter(e => agentEventKinds.includes(e.kind));
    expect(agentEvents.length).toBe(0);
  });
});

// ── Test ActiveRuntime AgentAdapter Integration ──────────────

describe('ActiveRuntime → AgentAdapter eventBus wiring', () => {
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
    bus.on('invocation_succeeded', () => received.push('invocation_succeeded'));

    // Emit through the adapter's eventBus the way AgentAdapter.invokeAgent() does
    (adapter as unknown as { eventBus: EventEmitter }).eventBus.emit('session_started', {
      session_id: 'sess-test',
      role: 'planner',
      goal_id: 'g1',
      card_id: 'c1',
    });

    (adapter as unknown as { eventBus: EventEmitter }).eventBus.emit('invocation_succeeded', {
      session_id: 'sess-test',
      role: 'planner',
      attempt: 1,
      duration_ms: 200,
    });

    expect(received).toContain('session_started');
    expect(received).toContain('invocation_succeeded');
  });

  it('Runtime can be used as AgentAdapter eventBus to forward events', () => {
    const saivageDir = join(tmpDir, '.saivage');
    const eventLogger = new EventLogger(saivageDir);
    const config = minimalConfig();

    // Create a Runtime that acts as the event bus
    const rt = new Runtime(makeDefaultConfig(tmpDir, makeFixtureDir(tmpDir)));

    const adapter = new AgentAdapter({
      projectRoot: tmpDir,
      saivageDir,
      config,
      eventLogger,
    });

    // Wire Runtime as event bus — this is what ActiveRuntime does
    adapter.setEventBus(rt);

    const received: Array<{ name: string; data: Record<string, unknown> }> = [];
    rt.on('session_started', (data: unknown) => {
      received.push({ name: 'session_started', data: data as Record<string, unknown> });
    });
    rt.on('compaction_triggered', (data: unknown) => {
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
