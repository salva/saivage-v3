import { describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';

import { AgentRoleRunner } from '../../src/agents/agent-role-runner.js';

describe('AgentRoleRunner', () => {
  it('owns self-check round state and emits self-check events', () => {
    const events: unknown[] = [];
    const bus = new EventEmitter();
    bus.on('self_check_triggered', (event) => events.push(event));
    const runner = new AgentRoleRunner({
      config: { runtime: { selfCheck: { planner: 2, executor: 0, reviewer: 0, analyst: 0 } } } as any,
      eventBus: bus,
    });

    expect(runner.applySelfCheck('planner', 'base prompt', 'planner:goal')).toBe('base prompt');
    const second = runner.applySelfCheck('planner', 'base prompt', 'planner:goal');

    expect(second).toContain('base prompt');
    expect(second).toContain('## Self-Check Assessment');
    expect(events).toEqual([{ session_id: 'planner:goal', role: 'planner', rounds: 2, threshold: 2 }]);
  });

  it('resets counters when role changes', () => {
    const runner = new AgentRoleRunner({
      config: { runtime: { selfCheck: { planner: 2, executor: 2, reviewer: 0, analyst: 0 } } } as any,
    });

    runner.applySelfCheck('planner', 'planner prompt', 'planner:goal');
    runner.resetOnRoleChange('executor');

    expect(runner.applySelfCheck('executor', 'executor prompt', 'executor:card')).toBe('executor prompt');
  });
});
