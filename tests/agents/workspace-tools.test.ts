import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { processWorkspaceToolCall, WORKSPACE_TOOL_DEFINITIONS } from '../../src/agents/workspace-tools.js';

describe('workspace tools', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-workspace-tools-'));
    mkdirSync(join(root, '.saivage'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# Test\n', 'utf8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const context = () => ({ projectRoot: root, sessionId: 'session-1', goalId: 'goal-1', cardId: 'code-1' });

  it('defines native project workspace tools', () => {
    expect(WORKSPACE_TOOL_DEFINITIONS.map((tool) => tool.function.name)).toEqual([
      'read',
      'write',
      'glob',
      'grep',
      'edit',
      'apply_patch',
      'run_command',
      'wait_process',
      'kill_process',
    ]);
  });

  it('globs project files without Saivage internal state', async () => {
    writeFileSync(join(root, '.saivage', 'secret.txt'), 'hidden', 'utf8');
    const result = await processWorkspaceToolCall('glob', JSON.stringify({ directory: '.', pattern: '**/*.md' }), context()) as { matches: string[] };
    expect(result.matches).toContain('README.md');
    expect(result.matches.some((file) => file.startsWith('.saivage/'))).toBe(false);
  });

  it('reads and writes project files inside the project root', async () => {
    await processWorkspaceToolCall(
      'write',
      JSON.stringify({ path: 'src/app.py', content: 'print("ok")\n' }),
      context(),
    );

    expect(readFileSync(join(root, 'src', 'app.py'), 'utf8')).toBe('print("ok")\n');

    const result = await processWorkspaceToolCall(
      'read',
      JSON.stringify({ path: 'src/app.py' }),
      context(),
    ) as { content: string };
    expect(result.content).toBe('print("ok")\n');
  });

  it('validates workspace inputs with canonical schemas before dispatch', async () => {
    await expect(processWorkspaceToolCall(
      'read',
      JSON.stringify({ path: 123 }),
      context(),
    )).rejects.toThrow();

    await expect(processWorkspaceToolCall(
      'write',
      JSON.stringify({ path: 'src/app.py', content: 'ok', extra: true }),
      context(),
    )).rejects.toThrow();

    await expect(processWorkspaceToolCall(
      'write',
      '{not json',
      context(),
    )).rejects.toThrow(/valid JSON/);
  });

  it('rejects writes outside the project root and to Saivage internals', async () => {
    await expect(processWorkspaceToolCall(
      'write',
      JSON.stringify({ path: '../outside.txt', content: 'nope' }),
      context(),
    )).rejects.toThrow(/Path traversal|inside the project root/);

    await expect(processWorkspaceToolCall(
      'write',
      JSON.stringify({ path: '.saivage/saivage.json', content: '{}' }),
      context(),
    )).rejects.toThrow(/Saivage internal state/);
  });

  it('waits for and no-op kills already-terminal processes', async () => {
    const started = await processWorkspaceToolCall(
      'run_command',
      JSON.stringify({ command: 'printf terminal', timeout_ms: 30000 }),
      context(),
    ) as { process_id: string; status: string; log_path: string };
    expect(started.status).toBe('exited');
    expect(started.log_path).toBe(`.saivage-work/processes/${started.process_id}/combined.log`);

    await expect(processWorkspaceToolCall(
      'wait_process',
      JSON.stringify({ process_id: started.process_id, timeout_ms: 1000 }),
      context(),
    )).resolves.toEqual(expect.objectContaining({ process_id: started.process_id, status: 'exited' }));

    await expect(processWorkspaceToolCall(
      'kill_process',
      JSON.stringify({ process_id: started.process_id }),
      context(),
    )).resolves.toEqual(expect.objectContaining({ process_id: started.process_id, terminated: true }));
  });

  it('runs commands through the project process runner', async () => {
    const result = await processWorkspaceToolCall(
      'run_command',
      JSON.stringify({ command: 'pwd && printf hello', timeout_ms: 30000 }),
      context(),
    ) as { process_id: string; status: string; exit_code: number | null; stdout: string; stderr: string; log_path: string };

    expect(result.status).toBe('exited');
    expect(result.exit_code).toBe(0);
    expect(result.log_path).toBe(`.saivage-work/processes/${result.process_id}/combined.log`);
    expect(existsSync(join(root, result.log_path))).toBe(true);
  });
});
