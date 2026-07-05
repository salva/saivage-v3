import { describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { registerOperatorContractRoutes } from '../../src/server/routes/operator-contracts.js';
import type { ProcessRecord } from '../../src/schemas/index.js';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';

function processRecord(projectRoot: string, overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    id: 'proc-1',
    card_id: 'card-1',
    owner_id: 'runtime-owner',
    command: 'echo hello',
    command_hash: 'a'.repeat(64),
    cwd: join(projectRoot, 'work'),
    cwd_canonical: join(projectRoot, 'work'),
    status: 'exited',
    pid: null,
    started_at: '2026-01-01T00:00:00.000Z',
    started_at_monotonic: 1,
    completed_at: '2026-01-01T00:00:01.000Z',
    exit_code: 0,
    signal: null,
    terminal_reason: 'exit',
    required_for_card_completion: true,
    output_dir: join(projectRoot, '.saivage-work', 'processes', 'proc-1'),
    stdout_path: join(projectRoot, '.saivage-work', 'processes', 'proc-1', 'stdout.log'),
    stderr_path: join(projectRoot, '.saivage-work', 'processes', 'proc-1', 'stderr.log'),
    combined_log_path: join(projectRoot, '.saivage-work', 'processes', 'proc-1', 'combined.log'),
    agent_session_id: null,
    goal_id: null,
    launch_reason: null,
    owner_kind: 'runtime',
    background_policy: null,
    process_group_id: null,
    failure_classification: null,
    ...overrides,
  };
}

describe('contract-backed process routes', () => {
  it('lists and reads safe process views without the old hand-mounted route owner', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-process-route-'));
    const fastify = Fastify({ logger: false });
    try {
      const processRunner = new ProcessRunner(projectRoot);
      processRunner.setTransientRegistry(new Map([['proc-1', processRecord(projectRoot)]]));
      registerOperatorContractRoutes({ fastify, projectRoot, runtimeApplication: { processRunner } as RuntimeApplication });

      const list = await fastify.inject({ method: 'GET', url: '/api/processes' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({
        processes: [expect.objectContaining({
          id: 'proc-1',
          card_id: 'card-1',
          owner_id: 'runtime-owner',
          status: 'exited',
          ended_at: '2026-01-01T00:00:01.000Z',
          exit_code: 0,
          logs: expect.objectContaining({ combined: expect.stringContaining('combined.log') }),
        })],
      });

      const detail = await fastify.inject({ method: 'GET', url: '/api/processes/proc-1' });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().process.id).toBe('proc-1');
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('preserves the existing missing-process 404 body', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-process-route-'));
    const fastify = Fastify({ logger: false });
    try {
      const processRunner = new ProcessRunner(projectRoot);
      processRunner.setTransientRegistry(new Map());
      registerOperatorContractRoutes({ fastify, projectRoot, runtimeApplication: { processRunner } as RuntimeApplication });

      const response = await fastify.inject({ method: 'GET', url: '/api/processes/missing' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Process not found', processId: 'missing' });
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
