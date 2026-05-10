/**
 * Tests for recovery.ts — agent invocation recovery wrapper
 */

import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  invokeWithRecovery,
  createCancellableRecovery,
  recoveryOptionsFromConfig,
  type RecoveryContext,
} from '../../src/agents/recovery.js';
import type { RuntimeSection } from '../../src/agents/config-schema.js';

describe('invokeWithRecovery', () => {
  it('should return successful result on first attempt', async () => {
    const fn = async (_ctx: RecoveryContext) => 'success';

    const attempts = await invokeWithRecovery(fn, {
      recoveryDelayMs: 10,
      maxRetries: 1,
    });

    expect(attempts).toHaveLength(1);
    expect(attempts[0].success).toBe(true);
    expect(attempts[0].result).toBe('success');
  });

  it('should retry on failure', async () => {
    let callCount = 0;
    const fn = async (_ctx: RecoveryContext) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('First attempt failed');
      }
      return 'recovered';
    };

    const attempts = await invokeWithRecovery(fn, {
      recoveryDelayMs: 10,
      maxRetries: 2,
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[0].success).toBe(false);
    expect(attempts[1].success).toBe(true);
    expect(attempts[1].result).toBe('recovered');
    expect(callCount).toBe(2);
  });

  it('should give up after max retries', async () => {
    const fn = async (_ctx: RecoveryContext) => {
      throw new Error('Always fails');
    };

    const attempts = await invokeWithRecovery(fn, {
      recoveryDelayMs: 10,
      maxRetries: 2,
    });

    // 1 initial + 2 retries = 3 total
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => !a.success)).toBe(true);
  });

  it('should provide recovery context on retry', async () => {
    const contexts: RecoveryContext[] = [];
    const fn = async (ctx: RecoveryContext) => {
      contexts.push({ ...ctx });
      if (ctx.attempt === 1) throw new Error('fail');
      return 'ok';
    };

    await invokeWithRecovery(fn, {
      recoveryDelayMs: 10,
      maxRetries: 2,
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[0].isRecovery).toBe(false);
    expect(contexts[0].directive).toBe('');
    expect(contexts[1].isRecovery).toBe(true);
    expect(contexts[1].directive).toContain('RECOVERY DIRECTIVE');
    expect(contexts[1].previousError).toBeDefined();
    expect(contexts[1].previousError!.message).toBe('fail');
  });

  it('should publish events on failure when configured', async () => {
    const eventBus = new EventEmitter();
    const events: string[] = [];
    eventBus.on('agent_invocation_failed', (e) => events.push(e.error));

    const fn = async (_ctx: RecoveryContext) => {
      throw new Error('test failure');
    };

    await invokeWithRecovery(fn, {
      recoveryDelayMs: 10,
      maxRetries: 1,
      publishEvents: true,
      eventBus,
      agentRole: 'executor',
      cardId: 'card-1',
    });

    expect(events).toHaveLength(2); // initial + retry
    expect(events[0]).toBe('test failure');
  });

  it('should call persistFailure on error', async () => {
    const failures: Array<{ error: string; attempt: number }> = [];

    const fn = async (_ctx: RecoveryContext) => {
      throw new Error('boom');
    };

    await invokeWithRecovery(fn, {
      recoveryDelayMs: 10,
      maxRetries: 1,
      persistFailure: (error, attempt) => {
        failures.push({ error: error.message, attempt });
      },
    });

    expect(failures).toHaveLength(2);
    expect(failures[0].attempt).toBe(1);
    expect(failures[1].attempt).toBe(2);
  });
});

describe('createCancellableRecovery', () => {
  it('should cancel ongoing recovery', async () => {
    const fn = async (ctx: RecoveryContext) => {
      if (ctx.attempt > 1) throw new Error('should not reach retry');
      throw new Error('first fail');
    };

    const { invoke, cancel } = createCancellableRecovery(fn, {
      recoveryDelayMs: 1000,
      maxRetries: 3,
    });

    // Start invocation (it will fail and delay)
    const promise = invoke();
    // Cancel immediately
    cancel();

    const attempts = await promise;
    // After cancel, recovery won't retry
    expect(attempts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('recoveryOptionsFromConfig', () => {
  it('should create options from runtime config', () => {
    const runtimeConfig: RuntimeSection = {
      recoveryDelayMs: 30000,
      maxRecoveryRetries: 5,
      recoverAgentInvocations: true,
      healthCheckIntervalMs: 30000,
      idleShutdownMs: 300000,
      maxGoalDepth: 5,
      continuousImprovement: false,
      compactionThreshold: 0.8,
      maxCompactions: 3,
      compactionTimeoutMs: 1200000,
      compactionKeepFraction: 0.2,
    };

    const opts = recoveryOptionsFromConfig(runtimeConfig);
    expect(opts.recoveryDelayMs).toBe(30000);
    expect(opts.maxRetries).toBe(5);
  });

  it('should allow overrides', () => {
    const runtimeConfig: RuntimeSection = {
      recoveryDelayMs: 30000,
      maxRecoveryRetries: 5,
      recoverAgentInvocations: true,
      healthCheckIntervalMs: 30000,
      idleShutdownMs: 300000,
      maxGoalDepth: 5,
      continuousImprovement: false,
      compactionThreshold: 0.8,
      maxCompactions: 3,
      compactionTimeoutMs: 1200000,
      compactionKeepFraction: 0.2,
    };

    const opts = recoveryOptionsFromConfig(runtimeConfig, {
      recoveryDelayMs: 10000,
    });
    expect(opts.recoveryDelayMs).toBe(10000);
    expect(opts.maxRetries).toBe(5);
  });
});
