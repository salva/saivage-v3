import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createProcessProvider } from '../../src/tools/process-provider.js';
import { getProcess } from '../../src/runtime/process-runner.js';

function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'saivage-process-provider-'));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('process provider', () => {
  it('runs foreground commands with canonical run_command', async () => withRoot(async (root) => {
    const surface = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, ownerId: 'activation-1', cardId: 'card-1' })]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf hello', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(expect.objectContaining({ exit_code: 0, stdout: 'hello' }));
  }));

  it('starts and inspects background commands', async () => withRoot(async (root) => {
    const surface = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, ownerId: 'activation-1', cardId: 'card-1' })]);
    const started = await invokeTool(surface, 'run_command', { command: 'sleep 1 && printf done', wait: false });
    expect(started.success).toBe(true);
    if (!started.success) return;
    const processId = (started.data as { process_id: string }).process_id;

    const inspected = await invokeTool(surface, 'wait_process', { process_id: processId, timeout_ms: 0 });

    expect(inspected.success).toBe(true);
    if (inspected.success) expect(inspected.data).toEqual({ process_id: processId, still_running: true });
  }));

  it('rejects process control from a different owner', async () => withRoot(async (root) => {
    const owner = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, ownerId: 'activation-1', cardId: 'card-1' })]);
    const stranger = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, ownerId: 'activation-2', cardId: 'card-1' })]);
    const started = await invokeTool(owner, 'run_command', { command: 'sleep 1', wait: false });
    expect(started.success).toBe(true);
    if (!started.success) return;
    const processId = (started.data as { process_id: string }).process_id;

    const denied = await invokeTool(stranger, 'kill_process', { process_id: processId });

    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error).toContain('not owned');
    await invokeTool(owner, 'kill_process', { process_id: processId });
  }));

  it('records Analyst command provenance as operator-owned session work', async () => withRoot(async (root) => {
    const surface = buildInvocationSurface('analyst', [createProcessProvider({ projectRoot: root, ownerId: 'analyst:global', agentRole: 'analyst', ownerKind: 'operator', launchReason: 'analyst workspace run_command' })]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf analyst', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const processId = (result.data as { process_id: string }).process_id;
    expect(getProcess(root, processId)).toEqual(expect.objectContaining({
      card_id: 'analyst:global',
      owner_id: 'analyst:global',
      agent_session_id: 'analyst:global',
      owner_kind: 'operator',
      launch_reason: 'analyst workspace run_command',
    }));
  }));

  it('records executor command provenance as agent-owned card work', async () => withRoot(async (root) => {
    const surface = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, ownerId: 'activation-1', cardId: 'card-1', agentRole: 'executor' })]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf executor', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const processId = (result.data as { process_id: string }).process_id;
    expect(getProcess(root, processId)).toEqual(expect.objectContaining({
      card_id: 'card-1',
      owner_id: 'activation-1',
      agent_session_id: 'activation-1',
      owner_kind: 'agent',
      launch_reason: 'executor process provider run_command',
    }));
  }));
});
