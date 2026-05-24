import { describe, it, expect } from '@jest/globals';
import { runtimeStateSchema } from '../../src/schemas/validators.js';

const baseRuntimeState = () => ({
  status: 'idle' as const,
  project_id: 'project' as const,
  started_at: '2026-05-23T00:00:00.000Z',
  current_card_id: null,
  current_agent_session_id: null,
  active_card_run: null,
  paused: false,
  paused_at: null,
  queue: [],
  running_processes: [],
  updated_at: '2026-05-23T00:00:00.000Z',
  frozen_reason: null,
  runtime_intent: { status: 'stopped' as const, updated_at: '2026-05-23T00:00:00.000Z', source_command_id: null, reason: null },
  runtime_commands: [],
  runtime_runs: [],
  runtime_activations: [],
});

describe('runtimeStateSchema no longer carries pid', () => {
  it('strips an extra pid key on parse', () => {
    const parsed = runtimeStateSchema.parse({ ...baseRuntimeState(), pid: 12345 });
    expect((parsed as Record<string, unknown>).pid).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(parsed, 'pid')).toBe(false);
  });

  it('parses a RuntimeState without pid as valid', () => {
    const parsed = runtimeStateSchema.parse(baseRuntimeState());
    expect((parsed as Record<string, unknown>).pid).toBeUndefined();
    expect(parsed.status).toBe('idle');
  });
});
