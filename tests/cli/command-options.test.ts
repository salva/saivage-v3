import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../../src/cli.js';

const originalCwd = process.cwd();
const roots: string[] = [];

function emptyProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-cli-options-'));
  roots.push(root);
  process.chdir(root);
  return root;
}

afterEach(() => {
  process.chdir(originalCwd);
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('command-specific CLI parsing', () => {
  it.each([
    ['init', ['--host', '127.0.0.1']],
    ['start', ['--profile', 'classic']],
    ['status', ['--host', '127.0.0.1']],
    ['pause', ['--port', '8081']],
    ['resume', ['--config', 'other.yaml']],
    ['stop', ['--project-root', '/tmp']],
    ['restart_server', ['--create-runtime']],
    ['reset', ['--profile', 'classic']],
    ['help', ['--host', '127.0.0.1']],
    ['--help', ['--port', '8081']],
    ['-h', ['--config', 'other.yaml']],
  ])('rejects an option not applicable to %s before effects', async (command, options) => {
    const root = emptyProject();
    await expect(run(['node', 'saivage', command, ...options])).rejects.toThrow();
    expect(existsSync(join(root, '.saivage'))).toBe(false);
  });

  it.each([
    ['init', ['unexpected']],
    ['start', ['unexpected']],
    ['status', ['unexpected']],
    ['reset', ['unexpected']],
    ['help', ['unexpected']],
  ])('rejects positional input for %s before effects', async (command, rest) => {
    const root = emptyProject();
    await expect(run(['node', 'saivage', command, ...rest])).rejects.toThrow();
    expect(existsSync(join(root, '.saivage'))).toBe(false);
  });

  it.each([
    ['init', '--profile'],
    ['start', '--host'],
    ['start', '--port'],
    ['start', '--config'],
    ['start', '--project-root'],
  ])('rejects a missing value for %s %s before effects', async (command, option) => {
    const root = emptyProject();
    await expect(run(['node', 'saivage', command, option])).rejects.toThrow();
    expect(existsSync(join(root, '.saivage'))).toBe(false);
  });

  it.each([
    ['init', '--profile', 'classic'],
    ['start', '--host', '127.0.0.1'],
    ['start', '--port', '8080'],
    ['start', '--config', 'saivage.yaml'],
    ['start', '--project-root', '/tmp'],
    ['start', '--create-runtime', undefined],
  ])('rejects equal repeated singleton %s %s before effects', async (command, option, value) => {
    const root = emptyProject();
    const occurrence = value === undefined ? [option] : [option, value];
    await expect(run(['node', 'saivage', command, ...occurrence, ...occurrence])).rejects.toThrow(`Option ${option} may only be specified once.`);
    expect(existsSync(join(root, '.saivage'))).toBe(false);
  });

  it.each([
    ['init', '--profile', 'classic'],
    ['start', '--host', '127.0.0.1'],
    ['start', '--port', '8080'],
    ['start', '--config', 'saivage.yaml'],
    ['start', '--project-root', '/tmp'],
  ])('rejects mixed separated/equals repetition for %s %s before effects', async (command, option, value) => {
    const root = emptyProject();
    await expect(run(['node', 'saivage', command, option, value, `${option}=${value}`])).rejects.toThrow(`Option ${option} may only be specified once.`);
    expect(existsSync(join(root, '.saivage'))).toBe(false);
  });

  it('rejects unknown options and commands before effects', async () => {
    const root = emptyProject();
    await expect(run(['node', 'saivage', 'start', '--unknown'])).rejects.toThrow();
    await expect(run(['node', 'saivage', 'unknown'])).rejects.toThrow('Unknown command: unknown');
    expect(existsSync(join(root, '.saivage'))).toBe(false);
  });

  it.each([[[]], [['help']], [['--help']], [['-h']]])('accepts the help form %j without effects', async (command: string[]) => {
    const root = emptyProject();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await run(['node', 'saivage', ...command]);
    expect(existsSync(join(root, '.saivage'))).toBe(false);
  });
});
