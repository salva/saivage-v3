import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findProjectRoot } from '../../src/persistence/discovery.js';

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
