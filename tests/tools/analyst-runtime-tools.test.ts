import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessRunner } from '../../src/runtime/process-runner.js';
import type { ProcessRecord } from '../../src/schemas/index.js';
import { list_processes_tool } from '../../src/tools/analyst-runtime-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';

function record(projectRoot: string): ProcessRecord {
  return { id: 'proc-1', card_id: 'card-1', owner_id: 'agent-1', command: 'echo hello', command_hash: 'a'.repeat(64), cwd: projectRoot, cwd_canonical: projectRoot, status: 'running', pid: 123, started_at: '2026-01-01T00:00:00.000Z', started_at_monotonic: 1, completed_at: null, exit_code: null, signal: null, terminal_reason: null, required_for_card_completion: true, output_dir: join(projectRoot, '.saivage-work', 'processes', 'proc-1'), stdout_path: join(projectRoot, '.saivage-work', 'processes', 'proc-1', 'stdout.log'), stderr_path: join(projectRoot, '.saivage-work', 'processes', 'proc-1', 'stderr.log'), combined_log_path: join(projectRoot, '.saivage-work', 'processes', 'proc-1', 'combined.log'), agent_session_id: 'agent-1', goal_id: null, launch_reason: null, owner_kind: 'agent', background_policy: null, process_group_id: 123, failure_classification: null };
}

describe('analyst runtime tools', () => {
  it('projects process logs as canonical work URLs', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-analyst-runtime-'));
    try {
      const processRunner = new ProcessRunner(projectRoot);
      processRunner.setTransientRegistry(new Map([['proc-1', record(projectRoot)]]));
      const result = await list_processes_tool({ projectRoot, processRunner, actor: 'analyst', surface: 'web' } as unknown as ToolContext, {});

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual([expect.objectContaining({ logs: { stdout: 'work:///processes/proc-1/stdout.log', stderr: 'work:///processes/proc-1/stderr.log', combined: 'work:///processes/proc-1/combined.log' } })]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
