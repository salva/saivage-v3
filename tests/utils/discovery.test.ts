import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findProjectRoot, loadProjectConfig, findSaivageDir } from '../../src/utils/discovery.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-discovery-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function createProjectAt(root: string): void {
  mkdirSync(join(root, '.saivage'), { recursive: true });
  writeFileSync(join(root, '.saivage', 'saivage.json'), '{"name":"test-project"}', 'utf-8');
}

describe('findProjectRoot', () => {
  it('finds project root from the root directory itself', () => {
    createProjectAt(tmpDir);
    const result = findProjectRoot(tmpDir);
    expect(result).toBe(tmpDir);
  });

  it('finds project root from a subdirectory', () => {
    createProjectAt(tmpDir);
    const deepDir = join(tmpDir, 'src', 'lib', 'nested');
    mkdirSync(deepDir, { recursive: true });

    const result = findProjectRoot(deepDir);
    expect(result).toBe(tmpDir);
  });

  it('finds project root from a deeply nested subdirectory', () => {
    createProjectAt(tmpDir);
    const deepDir = join(tmpDir, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(deepDir, { recursive: true });

    const result = findProjectRoot(deepDir);
    expect(result).toBe(tmpDir);
  });

  it('returns null when no .saivage/saivage.json exists anywhere up the tree', () => {
    const deepDir = join(tmpDir, 'x', 'y', 'z');
    mkdirSync(deepDir, { recursive: true });

    const result = findProjectRoot(deepDir);
    expect(result).toBeNull();
  });

  it('returns null from a directory with .saivage/ but no saivage.json', () => {
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    // no saivage.json inside

    const result = findProjectRoot(tmpDir);
    expect(result).toBeNull();
  });

  it('stops at filesystem root when no marker is found', () => {
    // Using tmpDir which has no .saivage marker
    const result = findProjectRoot(tmpDir);
    expect(result).toBeNull();
  });

  it('finds the nearest ancestor, not a more distant one', () => {
    // Create a project at tmpDir level
    createProjectAt(tmpDir);

    // Create a subdirectory that has its own .saivage/saivage.json
    const childProject = join(tmpDir, 'child-project');
    createProjectAt(childProject);

    // From within child-project, should find child-project, not tmpDir
    const deepDir = join(childProject, 'src');
    mkdirSync(deepDir, { recursive: true });

    const result = findProjectRoot(deepDir);
    expect(result).toBe(childProject);
  });

  it('defaults startDir to process.cwd() when not provided', () => {
    const result = findProjectRoot();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('loadProjectConfig', () => {
  it('reads and parses saivage.json correctly', () => {
    createProjectAt(tmpDir);
    // Override with custom content
    writeFileSync(
      join(tmpDir, '.saivage', 'saivage.json'),
      JSON.stringify({ name: 'my-project', version: 1, tags: ['a', 'b'] }),
      'utf-8',
    );

    const config = loadProjectConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.name).toBe('my-project');
    expect(config!.version).toBe(1);
    expect(config!.tags).toEqual(['a', 'b']);
  });

  it('returns null when no project is found', () => {
    const result = loadProjectConfig(tmpDir);
    expect(result).toBeNull();
  });

  it('returns null from a subdirectory with no parent project', () => {
    const deepDir = join(tmpDir, 'no', 'project', 'here');
    mkdirSync(deepDir, { recursive: true });

    const result = loadProjectConfig(deepDir);
    expect(result).toBeNull();
  });

  it('finds and loads config from a subdirectory of a project', () => {
    createProjectAt(tmpDir);
    writeFileSync(
      join(tmpDir, '.saivage', 'saivage.json'),
      JSON.stringify({ key: 'value' }),
      'utf-8',
    );

    const result = loadProjectConfig(join(tmpDir, 'src', 'sub'));
    expect(result).toEqual({ key: 'value' });
  });

  it('throws on invalid JSON in saivage.json', () => {
    createProjectAt(tmpDir);
    writeFileSync(
      join(tmpDir, '.saivage', 'saivage.json'),
      '{ invalid json !!! }',
      'utf-8',
    );

    expect(() => loadProjectConfig(tmpDir)).toThrow(SyntaxError);
  });

  it('parses empty object', () => {
    createProjectAt(tmpDir);
    writeFileSync(join(tmpDir, '.saivage', 'saivage.json'), '{}', 'utf-8');

    const config = loadProjectConfig(tmpDir);
    expect(config).toEqual({});
  });
});

describe('findSaivageDir', () => {
  it('returns the .saivage/ directory path from project root', () => {
    createProjectAt(tmpDir);
    const result = findSaivageDir(tmpDir);
    expect(result).toBe(join(tmpDir, '.saivage'));
  });

  it('returns the .saivage/ directory path from a subdirectory', () => {
    createProjectAt(tmpDir);
    const subDir = join(tmpDir, 'deep', 'path');
    mkdirSync(subDir, { recursive: true });

    const result = findSaivageDir(subDir);
    expect(result).toBe(join(tmpDir, '.saivage'));
  });

  it('returns null when no project is found', () => {
    const result = findSaivageDir(tmpDir);
    expect(result).toBeNull();
  });
});
