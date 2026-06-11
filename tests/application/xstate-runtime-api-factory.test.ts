import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../src/events/index.js';
import { createXStateRuntimeApi } from '../../src/application/xstate-runtime-api-factory.js';
import type { CardRecord } from '../../src/schemas/index.js';
import type { InvocationRequest } from '../../src/agents/invocation-service.js';
import type { GoalCardStorePort, InvocationTurnService, TerminalCardStorePort, XStateChildCardReader } from '../../src/runtime/actors/index.js';
import type { RuntimeContextCardReader } from '../../src/runtime/context-builder.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-xstate-runtime-factory-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

describe('createXStateRuntimeApi', () => {
  it('constructs a RuntimeApi backed by InvocationService provider turns and CardStore ports', async () => withTempProject(async (projectRoot) => {
    const projectCard = {
      id: 'project',
      type: 'project',
      parent: null,
      depth: 0,
      position: 0,
      title: 'Project Goal',
      description: 'Complete the project',
      status: 'backlog',
      lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'user',
      created_at: '2026-06-12T00:00:00.000Z',
      updated_at: '2026-06-12T00:00:00.000Z',
      version_seq: 1,
      depends_on: [],
      related: [],
      acceptance: 'Done means complete.',
      artifacts: [],
      attachments: [],
      retries: 0,
    } as CardRecord;
    const cardStore: XStateChildCardReader & RuntimeContextCardReader & GoalCardStorePort & TerminalCardStorePort = {
      read: jest.fn((cardId: string) => cardId === 'project' ? projectCard : null),
      listChildren: jest.fn(() => []),
      blocksFor: jest.fn(() => []),
      setStatus: jest.fn(() => ({} as CardRecord)),
      commitTerminalLifecyclePatch: jest.fn(() => ({} as CardRecord)),
    };
    const invocationService: InvocationTurnService = {
      invokeWithRecovery: jest.fn(async (request: InvocationRequest) => ({ kind: 'message' as const, content: request.role === 'reviewer' ? 'pass' : 'done from invocation service' })),
    };
    const api = createXStateRuntimeApi({
      projectRoot,
      eventBus: new EventBus(),
      cardStore,
      invocationService,
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(true);
    expect(invocationService.invokeWithRecovery).toHaveBeenCalledWith(expect.objectContaining({
      role: 'planner',
      sessionId: 'planner:project',
      systemPrompt: expect.stringContaining('Project Goal'),
    }));
    expect(cardStore.read).toHaveBeenCalledWith('project');
    expect(cardStore.setStatus).toHaveBeenCalledWith('project', 'running');
    expect(cardStore.commitTerminalLifecyclePatch).toHaveBeenCalledWith('project', expect.objectContaining({
      status: 'done',
      status_text: 'done from invocation service',
    }));
  }));
});
