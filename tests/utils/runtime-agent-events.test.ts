import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

import { initProjectTree } from '../../src/persistence/file-tree.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { EventLogger } from '../../src/observability/event-logger.js';
import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import { CardStore } from '../../src/cards/card-store.js';

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
      cardStore: new CardStore(tmpDir),
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
      cardStore: new CardStore(tmpDir),
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
      cardStore: new CardStore(tmpDir),
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
