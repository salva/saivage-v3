import { describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { EventQueryService } from '../../src/application/event-query-service.js';
import { createEventLog } from '../../src/observability/event-logger.js';
import { pause_runtime, resume_runtime, start_project, stop_project } from '../../src/tools/analyst-runtime-tools.js';
import { globalObservationToolBinders, type GlobalObservationToolContext } from '../../src/tools/global-observation-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { CardService } from '../helpers/canonical-project.js';
import { initProjectTree } from '../helpers/canonical-project.js';

describe('analyst runtime tools', () => {
  async function invokeObservation(name: string, context: GlobalObservationToolContext, args: unknown) {
    const binder = globalObservationToolBinders.find((candidate) => candidate.name === name)!;
    return (await binder.bind(context).executor(args, new AbortController().signal)).providerOutcome;
  }

  function controlContext(overrides: Record<string, unknown> = {}): ToolContext {
    return {
      runtime: {
        startProject: jest.fn(async () => ({ runtime: null, status: 'stopped', started: true, stopped: false })),
        pause: jest.fn(),
        resume: jest.fn(),
        stopProject: jest.fn(async () => ({ status: 'stopped', contained: true })),
        getStatus: jest.fn(() => ({ status: 'running', currentCardId: null, pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' })),
        cancelCard: jest.fn(),
        ...overrides,
      },
    } as unknown as ToolContext;
  }

  it('delegates Start without arguments and preserves success and failure mappings', async () => {
    const success = controlContext();
    await expect(start_project(success, {})).resolves.toEqual({ kind: 'succeeded', data: { runtime: null, status: 'stopped', started: true, stopped: false } });
    expect(success.runtime!.startProject).toHaveBeenCalledWith();

    const failure = controlContext({ startProject: jest.fn(async () => ({ runtime: null, status: 'stopped', started: false, stopped: true, error: 'start failed' })) });
    await expect(start_project(failure, {})).resolves.toEqual({ kind: 'failed', error: 'start failed', data: { status: 'stopped', started: false, stopped: true } });
    expect(failure.runtime!.startProject).toHaveBeenCalledWith();
  });

  it('propagates launch failure without manufacturing successful Analyst data', async () => {
    const context = controlContext({ startProject: jest.fn(async () => { throw new Error('launch failed'); }) });
    await expect(start_project(context, {})).rejects.toThrow('launch failed');
  });

  it('delegates Pause, Resume, and Stop without arguments and preserves status results', async () => {
    const paused = controlContext({ getStatus: jest.fn(() => ({ status: 'paused', currentCardId: null, pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' })) });
    await expect(pause_runtime(paused, {})).resolves.toEqual({ kind: 'succeeded', data: { status: 'paused' } });
    expect(paused.runtime!.pause).toHaveBeenCalledWith();

    const getStatus = jest.fn()
      .mockReturnValueOnce({ status: 'paused', currentCardId: null, pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' })
      .mockReturnValueOnce({ status: 'running', currentCardId: null, pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' });
    const resumed = controlContext({ getStatus });
    await expect(resume_runtime(resumed, {})).resolves.toEqual({ kind: 'succeeded', data: { status: 'running' } });
    expect(resumed.runtime!.resume).toHaveBeenCalledWith();
    expect(getStatus).toHaveBeenCalledTimes(2);

    const stopped = controlContext();
    await expect(stop_project(stopped, {})).resolves.toEqual({ kind: 'succeeded', data: { status: 'stopped', contained: true } });
    expect(stopped.runtime!.stopProject).toHaveBeenCalledWith();
  });

  it('does not delegate Resume while runtime status is error', async () => {
    const getStatus = jest.fn(() => ({ status: 'error' as const, currentCardId: null, pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' }));
    const context = controlContext({ getStatus });
    await expect(resume_runtime(context, {})).resolves.toEqual({
      kind: 'failed',
      error: 'Runtime is in error state. Inspect Debug Errors and fix the underlying failure before attempting recovery.',
      data: { runtime_status: 'error' },
    });
    expect(context.runtime!.resume).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('reads retained events and errors through the real event query authority', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-analyst-events-'));
    try {
      const log = createEventLog(projectRoot);
      log.appendEvent({ id: 'diagnostic-old', kind: 'runtime_diagnostic', timestamp: '2026-07-18T00:00:00.000Z', phase: 'planner', error_message: 'older failure' });
      log.appendEvent({ id: 'mcp-ok', kind: 'mcp_tool_invocation', timestamp: '2026-07-18T00:00:01.000Z', server: 'tools', tool: 'inspect', success: true, duration_ms: 1 });
      log.appendEvent({ id: 'diagnostic-new', kind: 'runtime_diagnostic', timestamp: '2026-07-18T00:00:02.000Z', phase: 'executor', error_message: 'newer failure' });
      log.appendEvent({ id: 'mcp-failed', kind: 'mcp_tool_invocation', timestamp: '2026-07-18T00:00:03.000Z', server: 'tools', tool: 'inspect', success: false, duration_ms: 2, error: 'tool failed' });
      const context = { projectRoot, eventQueries: new EventQueryService(projectRoot) } as GlobalObservationToolContext;

      await expect(invokeObservation('read_runtime_events', context, { limit: 1, kind: 'runtime_diagnostic' })).resolves.toEqual({
        kind: 'succeeded',
        data: {
          total_lines: 2,
          parse_errors: 0,
          events: expect.objectContaining({ total: 1, returned: 1, items: [expect.objectContaining({ id: 'diagnostic-new', kind: 'runtime_diagnostic' })] }),
        },
      });
      await expect(invokeObservation('read_runtime_errors', context, { limit: 2 })).resolves.toEqual({
        kind: 'succeeded',
        data: {
          total_lines: 3,
          parse_errors: 0,
          errors: expect.objectContaining({ total: 2, returned: 2, items: [
            expect.objectContaining({ id: 'diagnostic-new', kind: 'runtime_diagnostic' }),
            expect.objectContaining({ id: 'mcp-failed', kind: 'mcp_tool_invocation', success: false }),
          ] }),
        },
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns ordinary filesystem observation failures but propagates malformed canonical reads', async () => {
    const missing = Object.assign(new Error('missing runtime events'), { code: 'ENOENT' });
    await expect(invokeObservation('read_runtime_events', {
      eventQueries: { queryEvents: () => { throw missing; } },
    } as unknown as GlobalObservationToolContext, {})).resolves.toMatchObject({ kind: 'failed', error: 'missing runtime events' });

    const malformed = new SyntaxError('malformed canonical runtime event');
    await expect(invokeObservation('read_runtime_events', {
      eventQueries: { queryEvents: () => { throw malformed; } },
    } as unknown as GlobalObservationToolContext, {})).rejects.toBe(malformed);
  });

  it('projects process logs as canonical work URLs', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-analyst-runtime-'));
    try {
      const cwd = join(projectRoot, 'subdir');
      mkdirSync(cwd);
      const processes = createTestProcessRunner(projectRoot);
      const processRunner = processes.processRunner;
      const processScope = processRunner.createDirectScope(processes.runtimeProcessRootScope, 'test-agent', 'runtime_card');
      const rawSecret = 'synthetic-command-secret';
      const process = processRunner.spawn({ command: `echo token=${rawSecret}`, cwd, directScope: processScope, category: 'runtime_card', cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', ownerId: 'agent-1', ownerKind: 'agent' });
      const result = await invokeObservation('list_processes_tool', { projectRoot, processRunner } as GlobalObservationToolContext, {});

      expect(result.kind).toBe('succeeded');
      if (result.kind === 'succeeded') {
        expect(result.data).toEqual({ processes: expect.objectContaining({ total: 1, returned: 1, items: [expect.objectContaining({
          card_id: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          owner_kind: 'agent',
          owner_id: 'agent-1',
          command: expect.stringContaining('[REDACTED]'),
          cwd: 'subdir',
          logs: {
            stdout: `work:///cards/card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/processes/${process.id}/stdout.log`,
            stderr: `work:///cards/card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/processes/${process.id}/stderr.log`,
          },
        })] }) });
        expect(JSON.stringify(result.data)).not.toContain(rawSecret);
      }
      await processRunner.waitForSettlement(process.id);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('projects the required stopped runtime status', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-analyst-status-'));
    try {
      initProjectTree(projectRoot);
      const processRunner = createTestProcessRunner(projectRoot).processRunner;
      const cards = new CardService(projectRoot);
      const card = cards.create({ type: 'code', parent: 'project', title: 'Stopped', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      cards.setStatus(card.id, 'running');
      cards.stopRunning(card.id);
      const runtime = { status: 'stopped' as const, currentCardId: null, pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' };
      const result = await invokeObservation('get_status', {
        agentName: 'analyst',
        projectRoot,
        store: cards,
        processRunner,
        eventQueries: new EventQueryService(projectRoot),
        runtime: { getStatus: jest.fn(() => runtime) },
        queueNotification: async () => { throw new Error('unused notification'); },
        captureExecutingLlmSnapshots: () => new Map(),
      }, {});
      expect(result).toMatchObject({ kind: 'succeeded', data: { runtime, runtimeSummary: { status: 'stopped', currentCardId: null }, statusCounts: { stopped: 1 }, counts: { stopped: 1 } } });
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});
