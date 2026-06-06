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
      'list_project_files',
      'read_project_file',
      'write_project_file',
      'wait_for_process',
      'kill_process',
      'start_and_wait',
      'run_project_command',
    ]);
  });

  it('can import the agent adapter after workspace tool definitions initialize', async () => {
    await expect(import('../../src/agents/agent-adapter.js')).resolves.toHaveProperty('AgentAdapter');
    expect(WORKSPACE_TOOL_DEFINITIONS.some((tool) => tool.function.name === 'run_project_command')).toBe(true);
  });

  it('lists project files without Saivage internal state', async () => {
    writeFileSync(join(root, '.saivage', 'secret.txt'), 'hidden', 'utf8');
    const result = await processWorkspaceToolCall('list_project_files', '{}', context()) as { files: string[] };
    expect(result.files).toContain('README.md');
    expect(result.files.some((file) => file.startsWith('.saivage/'))).toBe(false);
  });

  it('reads and writes project files inside the project root', async () => {
    await processWorkspaceToolCall(
      'write_project_file',
      JSON.stringify({ path: 'src/app.py', content: 'print("ok")\n' }),
      context(),
    );

    expect(readFileSync(join(root, 'src', 'app.py'), 'utf8')).toBe('print("ok")\n');

    const result = await processWorkspaceToolCall(
      'read_project_file',
      JSON.stringify({ path: 'src/app.py' }),
      context(),
    ) as { content: string };
    expect(result.content).toBe('print("ok")\n');
  });

  it('validates workspace inputs with canonical schemas before dispatch', async () => {
    await expect(processWorkspaceToolCall(
      'read_project_file',
      JSON.stringify({ path: 123 }),
      context(),
    )).rejects.toThrow();

    await expect(processWorkspaceToolCall(
      'write_project_file',
      JSON.stringify({ path: 'src/app.py', content: 'ok', extra: true }),
      context(),
    )).rejects.toThrow();

    await expect(processWorkspaceToolCall(
      'write_project_file',
      '{not json',
      context(),
    )).rejects.toThrow(/valid JSON/);
  });

  it('rejects writes outside the project root and to Saivage internals', async () => {
    await expect(processWorkspaceToolCall(
      'write_project_file',
      JSON.stringify({ path: '../outside.txt', content: 'nope' }),
      context(),
    )).rejects.toThrow(/inside the project root/);

    await expect(processWorkspaceToolCall(
      'write_project_file',
      JSON.stringify({ path: '.saivage/saivage.json', content: '{}' }),
      context(),
    )).rejects.toThrow(/Saivage internal state/);
  });

  it('waits for and no-op kills already-terminal processes', async () => {
    const started = await processWorkspaceToolCall(
      'run_project_command',
      JSON.stringify({ command: 'printf terminal', timeoutMs: 30000 }),
      context(),
    ) as { id: string; status: string; logFiles: { combined: string; stdout: string; stderr: string } };
    expect(started.status).toBe('exited');
    expect(started.logFiles.combined).toBe(`.saivage-work/processes/${started.id}/combined.log`);

    await expect(processWorkspaceToolCall(
      'wait_for_process',
      JSON.stringify({ processId: started.id, timeoutMs: 1000 }),
      context(),
    )).resolves.toEqual(expect.objectContaining({ id: started.id, status: 'exited', timedOut: false }));

    await expect(processWorkspaceToolCall(
      'kill_process',
      JSON.stringify({ processId: started.id }),
      context(),
    )).resolves.toEqual(expect.objectContaining({ id: started.id, status: 'exited' }));
  });

  it('runs commands through the project process runner', async () => {
    const result = await processWorkspaceToolCall(
      'run_project_command',
      JSON.stringify({ command: 'pwd && printf hello', timeoutMs: 30000 }),
      context(),
    ) as { id: string; status: string; exitCode: number | null; output: string; logFiles: { combined: string; stdout: string; stderr: string } };

    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(root);
    expect(result.output).toContain('hello');
    expect(result.logFiles).toEqual({
      combined: `.saivage-work/processes/${result.id}/combined.log`,
      stdout: `.saivage-work/processes/${result.id}/stdout.log`,
      stderr: `.saivage-work/processes/${result.id}/stderr.log`,
    });
    expect(existsSync(join(root, result.logFiles.combined))).toBe(true);
    expect(existsSync(join(root, result.logFiles.stdout))).toBe(true);
    expect(existsSync(join(root, result.logFiles.stderr))).toBe(true);
  });
});
