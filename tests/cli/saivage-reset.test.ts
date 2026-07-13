import { initProjectTree } from '../helpers/canonical-project.js';
import { describe, it, expect, jest } from '@jest/globals';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isInitialized } from '../../src/persistence/file-tree.js';
import { run } from '../../src/cli.js';
import { acquireLock, releaseLock } from '../../src/runtime/lock.js';

function validProjectJson(name = 'reset-test'): string {
  return JSON.stringify({ id: 'project', name, context: '', goals_summary: '', constraints: [], planner_enabled: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }, null, 2) + '\n';
}


describe('saivage CLI compatibility cleanup', () => {
  it('does not advertise unsupported freeze or kill-processes help', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await run(['node', 'cli', 'help']);
      const output = log.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
      expect(output).not.toContain('saivage freeze');
      expect(output).not.toContain('--kill-processes');
    } finally {
      log.mockRestore();
    }
  });

  it('treats freeze as an unknown command', async () => {
    await expect(run(['node', 'cli', 'freeze'])).rejects.toThrow('Unknown command: freeze');
  });

  it('rejects the removed kill-processes option instead of parsing it', async () => {
    await expect(run(['node', 'cli', 'status', '--kill-processes'])).rejects.toThrow(/Unknown option|Unknown argument|Option/);
  });
});

describe('saivage reset', () => {
  it('advertises current reset preservation and reinitialization semantics', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await run(['node', 'cli', 'help']);
      const output = log.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
      expect(output).toContain('.saivage/state');
      expect(output).toContain('.saivage/logs');
      expect(output).toContain('.saivage/locks/runtime.lock');
      expect(output).toContain('.saivage/config/prompts/');
      expect(output).toContain('.saivage/skills/index.json');
      expect(output).toContain('.saivage/instructions/');
      expect(output).toContain('.saivage-work/');
      expect(output).toContain('.saivage/outputs');
      expect(output).toContain('.saivage/views');
      expect(output).toContain('live runtime owns it regardless of lock age');
      expect(output).toContain('fails closed without');
      expect(output).toContain('root project card');
      expect(output).not.toContain('.saivage/work/tmp/runtime');
    } finally {
      log.mockRestore();
    }
  });

  it('removes generated roots and obsolete roots, preserves durable inputs, and recreates the current empty layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-reset-'));
    const cwd = process.cwd();
    const objectivePath = join(root, 'research', 'future-objectives', 'analyst-system-control-objectives.md');
    const designPath = join(root, 'research', 'future-objectives', 'analyst-system-control-design.md');
    const planPath = join(root, 'research', 'future-objectives', 'analyst-system-control-implementation-plan.md');
    const objectiveContent = '# objectives\nkeep me\n';
    const designContent = '# design\nkeep me\n';
    const planContent = '# implementation plan\nkeep me\n';
    const promptPath = join(root, '.saivage', 'config', 'prompts', 'project', 'planner.md');
    const promptContent = '# Custom planner prompt\n';
    try {
      initProjectTree(root);
      mkdirSync(join(root, '.saivage', 'notes', 'by-card', 'x'), { recursive: true });
      mkdirSync(join(root, '.saivage', 'runtime'), { recursive: true });
      mkdirSync(join(root, '.saivage', 'tmp'), { recursive: true });
      mkdirSync(join(root, '.saivage', 'archive'), { recursive: true });
      mkdirSync(join(root, '.saivage', 'supervision'), { recursive: true });
      mkdirSync(join(root, '.saivage', 'outputs'), { recursive: true });
      mkdirSync(join(root, '.saivage', 'views'), { recursive: true });
      mkdirSync(join(root, '.saivage', 'stages', 'stage-1'), { recursive: true });
      mkdirSync(join(root, '.saivage', 'work', 'tmp', 'uploads'), { recursive: true });
      mkdirSync(join(root, '.saivage-work', 'tmp'), { recursive: true });
      mkdirSync(join(root, 'research', 'future-objectives'), { recursive: true });
      mkdirSync(join(promptPath, '..'), { recursive: true });
      writeFileSync(join(root, '.saivage', 'auth-profiles.json'), '{"keep":true}');
      writeFileSync(join(root, '.saivage', 'project.json'), validProjectJson('Preserved Project'));
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), 'server:\n  host: "127.0.0.1"\n  port: 0\nmodels:\n  default: ["gpt-4.1"]\nproviders: {}\n');
      writeFileSync(join(root, '.saivage', 'skills', 'index.json'), '[{"id":"keep-skill"}]\n');
      writeFileSync(join(root, '.saivage', 'instructions', 'operator.md'), 'keep instructions\n');
      writeFileSync(promptPath, promptContent);
      writeFileSync(objectivePath, objectiveContent);
      writeFileSync(designPath, designContent);
      writeFileSync(planPath, planContent);
      process.chdir(root);
      await run(['node', 'cli', 'reset']);
      expect(isInitialized(root)).toBe(true);
      expect(existsSync(join(root, '.saivage', 'cards', 'project'))).toBe(true);
      expect(existsSync(join(root, '.saivage', 'state', 'runtime.json'))).toBe(true);
      expect(readFileSync(join(root, '.saivage', 'logs', 'app.jsonl'), 'utf8')).toBe('');
      expect(existsSync(join(root, '.saivage', 'locks'))).toBe(true);
      expect(existsSync(join(root, '.saivage', 'locks', 'runtime.lock'))).toBe(false);
      for (const oldRoot of ['runtime', 'tmp', 'archive', 'supervision', 'notes', 'outputs', 'views']) expect(existsSync(join(root, '.saivage', oldRoot))).toBe(false);
      expect(existsSync(join(root, '.saivage-work'))).toBe(false);
      expect(existsSync(join(root, '.saivage', 'stages'))).toBe(true);
      for (const removedWork of ['downloads', 'quarantine', 'tmp/runtime', 'tmp/uploads', 'tmp/previews']) expect(existsSync(join(root, '.saivage', 'work', removedWork))).toBe(false);
      expect(existsSync(join(root, '.saivage', 'auth-profiles.json'))).toBe(true);
      expect(existsSync(join(root, '.saivage', 'project.json'))).toBe(true);
      expect(readFileSync(promptPath, 'utf8')).toBe(promptContent);
      expect(readFileSync(join(root, '.saivage', 'skills', 'index.json'), 'utf8')).toContain('keep-skill');
      expect(readFileSync(join(root, '.saivage', 'instructions', 'operator.md'), 'utf8')).toBe('keep instructions\n');
      expect(existsSync(objectivePath)).toBe(true);
      expect(existsSync(designPath)).toBe(true);
      expect(existsSync(planPath)).toBe(true);
      expect(readFileSync(objectivePath, 'utf8')).toBe(objectiveContent);
      expect(readFileSync(designPath, 'utf8')).toBe(designContent);
      expect(readFileSync(planPath, 'utf8')).toBe(planContent);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses without deleting while the canonical runtime lock has a live holder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-reset-lock-'));
    const cwd = process.cwd();
    const marker = join(root, '.saivage', 'state', 'runtime.json');
    try {
      initProjectTree(root);
      const handle = acquireLock(root);
      process.chdir(root);
      await expect(run(['node', 'cli', 'reset'])).rejects.toThrow(/lock/i);
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(join(root, '.saivage', 'cards', 'project'))).toBe(true);
      releaseLock(handle);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses without deleting when an old valid runtime lock names a live PID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-reset-old-lock-'));
    const cwd = process.cwd();
    const marker = join(root, '.saivage', 'state', 'runtime.json');
    const lockPath = join(root, '.saivage', 'locks', 'runtime.lock');
    try {
      initProjectTree(root);
      const before = readFileSync(marker, 'utf8');
      const oldStartedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: oldStartedAt }, null, 2) + '\n');
      process.chdir(root);

      await expect(run(['node', 'cli', 'reset'])).rejects.toThrow(/live PID/);

      expect(readFileSync(marker, 'utf8')).toBe(before);
      expect(existsSync(join(root, '.saivage', 'cards', 'project'))).toBe(true);
      expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual({ pid: process.pid, started_at: oldStartedAt });
    } finally {
      if (existsSync(lockPath)) rmSync(lockPath, { force: true });
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses without deleting when the existing runtime lock cannot be read', async () => {
    if (process.getuid?.() === 0) return;
    const root = mkdtempSync(join(tmpdir(), 'saivage-reset-unreadable-lock-'));
    const cwd = process.cwd();
    const marker = join(root, '.saivage', 'state', 'runtime.json');
    const lockPath = join(root, '.saivage', 'locks', 'runtime.lock');
    try {
      initProjectTree(root);
      const before = readFileSync(marker, 'utf8');
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: '2026-01-01T00:00:00.000Z' }, null, 2) + '\n');
      chmodSync(lockPath, 0o000);
      process.chdir(root);

      await expect(run(['node', 'cli', 'reset'])).rejects.toThrow(/Cannot read runtime lock/);

      chmodSync(lockPath, 0o600);
      expect(readFileSync(marker, 'utf8')).toBe(before);
      expect(existsSync(join(root, '.saivage', 'cards', 'project'))).toBe(true);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      try { chmodSync(lockPath, 0o600); } catch { void 0; }
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves reset projects initialized so init reports already initialized and status reads current state path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-reset-flow-'));
    const cwd = process.cwd();
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      initProjectTree(root);
      const promptPath = join(root, '.saivage', 'config', 'prompts', 'project', 'planner.md');
      mkdirSync(join(promptPath, '..'), { recursive: true });
      writeFileSync(promptPath, '# Preserve me\n');
      process.chdir(root);
      await run(['node', 'cli', 'reset']);
      log.mockClear();
      await run(['node', 'cli', 'init']);
      expect(log.mock.calls.map((call) => String(call[0] ?? '')).join('\n')).toContain('already initialized');
      log.mockClear();
      await run(['node', 'cli', 'status']);
      const status = log.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
      expect(status).toContain('Status:');
      expect(status).not.toContain('.saivage/tmp/state/runtime.json');
      expect(readFileSync(promptPath, 'utf8')).toBe('# Preserve me\n');
    } finally {
      log.mockRestore();
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('saivage init', () => {
  it('completes the generated layout from preserved durable files without changing prompt overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-init-preserved-'));
    const cwd = process.cwd();
    const promptPath = join(root, '.saivage', 'config', 'prompts', 'project', 'planner.md');
    try {
      mkdirSync(join(promptPath, '..'), { recursive: true });
      writeFileSync(join(root, '.saivage', 'project.json'), validProjectJson('Durable Only'));
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), 'server:\n  host: "127.0.0.1"\n  port: 0\nmodels:\n  default: ["gpt-4.1"]\nproviders: {}\n');
      writeFileSync(promptPath, '# Durable prompt\n');
      expect(isInitialized(root)).toBe(false);
      process.chdir(root);
      await run(['node', 'cli', 'init']);
      expect(isInitialized(root)).toBe(true);
      expect(existsSync(join(root, '.saivage', 'cards', 'project'))).toBe(true);
      expect(readFileSync(promptPath, 'utf8')).toBe('# Durable prompt\n');
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
