import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { list_processes_tool, pause_runtime, resume_runtime, start_project, stop_project } from '../../src/tools/analyst-runtime-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';

describe('analyst runtime tools', () => {
  function controlContext(overrides: Record<string, unknown> = {}): ToolContext {
    return {
      runtimeControl: {
        startProject: jest.fn(async () => ({ runtime: null, status: 'stopped', started: true, stopped: false })),
        pause: jest.fn(),
        resume: jest.fn(),
        stopProject: jest.fn(async () => ({ status: 'stopped', contained: true })),
        getStatus: jest.fn(() => ({ status: 'running', currentCardId: null, goalCount: 0, lastTickAt: null })),
        cancelCard: jest.fn(),
        ...overrides,
      },
    } as unknown as ToolContext;
  }

  it('delegates Start without arguments and preserves success and failure mappings', async () => {
    const success = controlContext();
    await expect(start_project(success, {})).resolves.toEqual({ success: true, data: { runtime: null, status: 'stopped', started: true, stopped: false } });
    expect(success.runtimeControl!.startProject).toHaveBeenCalledWith();

    const failure = controlContext({ startProject: jest.fn(async () => ({ runtime: null, status: 'stopped', started: false, stopped: true, error: 'start failed' })) });
    await expect(start_project(failure, {})).resolves.toEqual({ success: false, error: 'start failed', data: { status: 'stopped', started: false, stopped: true } });
    expect(failure.runtimeControl!.startProject).toHaveBeenCalledWith();
  });

  it('delegates Pause, Resume, and Stop without arguments and preserves status results', async () => {
    const paused = controlContext({ getStatus: jest.fn(() => ({ status: 'paused', currentCardId: null, goalCount: 0, lastTickAt: null })) });
    await expect(pause_runtime(paused, {})).resolves.toEqual({ success: true, data: { status: 'paused' } });
    expect(paused.runtimeControl!.pause).toHaveBeenCalledWith();

    const getStatus = jest.fn()
      .mockReturnValueOnce({ status: 'paused', currentCardId: null, goalCount: 0, lastTickAt: null })
      .mockReturnValueOnce({ status: 'running', currentCardId: null, goalCount: 0, lastTickAt: null });
    const resumed = controlContext({ getStatus });
    await expect(resume_runtime(resumed, {})).resolves.toEqual({ success: true, data: { status: 'running' } });
    expect(resumed.runtimeControl!.resume).toHaveBeenCalledWith();
    expect(getStatus).toHaveBeenCalledTimes(2);

    const stopped = controlContext();
    await expect(stop_project(stopped, {})).resolves.toEqual({ success: true, data: { status: 'stopped', contained: true } });
    expect(stopped.runtimeControl!.stopProject).toHaveBeenCalledWith();
  });

  it('does not delegate Resume while runtime status is error', async () => {
    const getStatus = jest.fn(() => ({ status: 'error' as const, currentCardId: null, goalCount: 0, lastTickAt: null }));
    const context = controlContext({ getStatus });
    await expect(resume_runtime(context, {})).resolves.toEqual({
      success: false,
      error: 'Runtime is in error state. Inspect Debug errors/timeline and fix the underlying failure before attempting recovery.',
      data: { runtime_status: 'error' },
    });
    expect(context.runtimeControl!.resume).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('projects process logs as canonical work URLs', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-analyst-runtime-'));
    try {
      const processRunner = createTestProcessRunner(projectRoot);
      const processScope = processRunner.createDirectScope(processRunner.runtimeRootScope, 'test-agent', 'runtime_card');
      const process = processRunner.spawn({ command: 'echo hello', directScope: processScope, category: 'runtime_card', cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', ownerId: 'agent-1', ownerKind: 'agent' });
      const result = await list_processes_tool({ projectRoot, processRunner, actor: 'analyst', surface: 'web' } as unknown as ToolContext, {});

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual([expect.objectContaining({ card_id: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', owner_kind: 'agent', owner_id: 'agent-1', logs: { stdout: `work:///cards/card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/processes/${process.id}/stdout.log`, stderr: `work:///cards/card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/processes/${process.id}/stderr.log` } })]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
