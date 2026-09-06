import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import {
  acquireRuntimeLifecycleLock,
  publishRuntimeControlEndpoint,
  releaseRuntimeLifecycleLock,
} from '../../src/runtime/lock.js';

const question = jest.fn(async () => 'RESTART SERVER');
const close = jest.fn();
const createInterface = jest.fn(() => ({ question, close }));

jest.unstable_mockModule('node:readline/promises', () => ({ createInterface }));

const { run } = await import('../../src/cli.js');

const originalCwd = process.cwd();
const originalToken = process.env.SAIVAGE_API_TOKEN;
const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout');

afterEach(() => {
  process.chdir(originalCwd);
  if (originalToken === undefined) delete process.env.SAIVAGE_API_TOKEN;
  else process.env.SAIVAGE_API_TOKEN = originalToken;
  if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
  if (originalStdout) Object.defineProperty(process, 'stdout', originalStdout);
  jest.restoreAllMocks();
  question.mockClear();
  close.mockClear();
  createInterface.mockClear();
});

describe('restart_server CLI delegation', () => {
  it('prints an acknowledged bearer restart and returns normally without exiting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-restart-'));
    const input = new PassThrough();
    const output = new PassThrough();
    const priorExitCode = process.exitCode;
    let lock: ReturnType<typeof acquireRuntimeLifecycleLock> | undefined;

    try {
      createProjectIdentity(root, 'CLI restart test');
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), '{}\n');
      process.chdir(root);
      lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
      publishRuntimeControlEndpoint(lock, { origin: 'http://127.0.0.1:45681', auth: 'bearer' });
      process.env.SAIVAGE_API_TOKEN = 'test-cli-restart-bearer';
      Object.defineProperty(process, 'stdin', { configurable: true, value: input });
      Object.defineProperty(process, 'stdout', { configurable: true, value: output });

      const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({ status: 'restart_scheduled' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      const exit = jest.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit must not be called by restart_server delegation');
      }) as typeof process.exit);

      await expect(run(['node', 'saivage', 'restart_server'])).resolves.toBeUndefined();

      expect(createInterface).toHaveBeenCalledWith({ input, output });
      expect(question).toHaveBeenCalledWith('Type RESTART SERVER to confirm: ');
      expect(close).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith('http://127.0.0.1:45681/api/runtime/restart-server', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer test-cli-restart-bearer',
          'content-type': 'application/json',
        },
        body: '{"confirmation":"RESTART SERVER"}',
      });
      expect(log).toHaveBeenCalledWith('{"status":"restart_scheduled"}');
      expect(exit).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(priorExitCode);
    } finally {
      if (lock) releaseRuntimeLifecycleLock(lock);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
