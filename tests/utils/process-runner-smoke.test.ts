import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

describe('ProcessRunner smoke', () => {
  it('waits for a managed command to settle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'process-runner-smoke-'));
    const registry = new ManagedProcessGroupRegistry();
    const runtimeRootScope = registry.createContainerScope(registry.rootScope, 'runtime');
    const runner = new ProcessRunner(root, registry, testApplicationFatalPort);
    const scope = runner.createDirectScope(runtimeRootScope, 'smoke', 'runtime_card');
    try {
      const record = runner.spawn({ command: 'exit 0', directScope: scope, category: 'runtime_card', ownerId: 'smoke', ownerKind: 'agent' });
      expect(record.id).toMatch(/^proc-[0-9a-f]{12}$/);
      await expect(runner.waitForSettlement(record.id)).resolves.toMatchObject({ status: 'exited', exitCode: 0 });
    } finally {
      await runner.terminateScopeTree({ rootScope: runtimeRootScope, categories: ['runtime_card'], reason: 'cleanup', graceMs: 100 });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes only inherited Git identity variables to a real child', async () => {
    const originalEnv = { ...process.env };
    const root = mkdtempSync(join(tmpdir(), 'process-runner-git-identity-'));
    const repository = join(root, 'repository');
    const emptyHome = join(root, 'home');
    const path = originalEnv.PATH ?? '/usr/bin:/bin';
    const registry = new ManagedProcessGroupRegistry();
    const runtimeRootScope = registry.createContainerScope(registry.rootScope, 'runtime');
    const runner = new ProcessRunner(repository, registry, testApplicationFatalPort);
    const scope = runner.createDirectScope(runtimeRootScope, 'git-identity', 'runtime_card');
    try {
      mkdirSync(emptyHome, { recursive: true });
      execFileSync('git', ['init', repository], {
        env: {
          PATH: path,
          HOME: emptyHome,
          USER: 'synthetic-user',
          LANG: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
        stdio: 'ignore',
      });

      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, {
        PATH: path,
        HOME: emptyHome,
        USER: 'synthetic-user',
        LANG: 'C',
        GIT_AUTHOR_NAME: 'Synthetic Author',
        GIT_AUTHOR_EMAIL: 'author@example.invalid',
        GIT_COMMITTER_NAME: 'Synthetic Committer',
        GIT_COMMITTER_EMAIL: 'committer@example.invalid',
        GIT_CONFIG: '/synthetic/forbidden-git-config',
        GIT_SSH_COMMAND: 'synthetic-forbidden-ssh-command',
        OPENAI_API_KEY: 'synthetic-provider-secret',
        SAIVAGE_API_TOKEN: 'synthetic-api-token',
        UNKNOWN_COMMAND_ENV: 'synthetic-unknown-value',
      });

      const command = [
        'if [ "${GIT_CONFIG+x}" = x ] || [ "${GIT_SSH_COMMAND+x}" = x ] || [ "${OPENAI_API_KEY+x}" = x ] || [ "${SAIVAGE_API_TOKEN+x}" = x ] || [ "${UNKNOWN_COMMAND_ENV+x}" = x ]; then exit 20; fi',
        'printf "sentinels-absent\\n"',
        'author_ident=$(GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git var GIT_AUTHOR_IDENT) || exit 21',
        'printf "author=%s\\n" "$author_ident"',
        'committer_ident=$(GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git var GIT_COMMITTER_IDENT) || exit 22',
        'printf "committer=%s\\n" "$committer_ident"',
      ].join('\n');
      const record = runner.spawn({ command, directScope: scope, category: 'runtime_card', ownerId: 'git-identity', ownerKind: 'agent' });

      await expect(runner.waitForSettlement(record.id)).resolves.toMatchObject({ status: 'exited', exitCode: 0 });
      const output = readFileSync(record.stdout_path, 'utf8').split('\n');
      expect(output).toContain('sentinels-absent');
      expect(output).toEqual(expect.arrayContaining([
        expect.stringMatching(/^author=Synthetic Author <author@example\.invalid> \d+ [+-]\d{4}$/),
        expect.stringMatching(/^committer=Synthetic Committer <committer@example\.invalid> \d+ [+-]\d{4}$/),
      ]));
    } finally {
      try {
        await runner.terminateScopeTree({ rootScope: runtimeRootScope, categories: ['runtime_card'], reason: 'cleanup', graceMs: 100 });
      } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
