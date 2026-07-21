import { initProjectTree } from '../helpers/canonical-project.js';
/**
 * Security Integration Tests
 *
 * Verifies:
 * - Path-policy behavior
 * - Sensitive file checks with file-tree utilities
 * - All modules work together without errors
 * - Existing file-tree tests still pass
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  writeFileSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as YAML from 'yaml';

import { readProjectFileAtomic } from '../../src/persistence/file-tree.js';
import {
  isReadBlocked,
  isRedacted,
  resolveContainedProjectPath,
} from '../../src/workspace/file-access-security.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';

// ── Helpers ───────────────────────────────────────────────────

let root: string;
let saivageDir: string;
let saivageWorkDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-security-integration-'));
  initProjectTree(root);
  saivageDir = join(root, '.saivage');
  saivageWorkDir = join(root, '.saivage/work');
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function writeSaivageConfig(json: Record<string, unknown>) {
  writeFileSync(
    join(saivageDir, 'saivage.yaml'),
    YAML.stringify(json),
    'utf-8',
  );
}

describe('workspace path policy primitives', () => {
  it('keeps blocked, redacted, and ordinary decisions distinct', () => {
    expect(isReadBlocked('.saivage/auth-profiles.json')).toBe(true);
    expect(isReadBlocked('.saivage/locks')).toBe(true);
    expect(isReadBlocked('.saivage/locks/not-created.lock')).toBe(true);
    expect(isRedacted('.saivage/saivage.yaml')).toBe(true);
    expect(isReadBlocked('.saivage/saivage.yaml')).toBe(false);
    expect(isReadBlocked('src/app.ts')).toBe(false);
    expect(isRedacted('src/app.ts')).toBe(false);
  });

  it('keeps lexical and existing real-target project identities separate', () => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'target.txt'), 'ordinary', 'utf8');
    symlinkSync('docs/target.txt', join(root, 'alias.txt'));

    expect(resolveContainedProjectPath(root, 'alias.txt')).toEqual(expect.objectContaining({
      safe: true,
      relativePath: 'alias.txt',
      realTargetProjectRelativePath: 'docs/target.txt',
    }));
    expect(resolveContainedProjectPath(root, 'missing.txt')).toEqual(expect.not.objectContaining({
      realTargetProjectRelativePath: expect.anything(),
    }));
  });
});

// ═══════════════════════════════════════════════════════════════
// Sensitive file checks with file-tree
// ═══════════════════════════════════════════════════════════════

describe('sensitive file checks with file-tree', () => {
  it('readProjectFileAtomic reads normal files', () => {
    const filePath = join(root, 'test.txt');
    writeFileSync(filePath, 'hello world', 'utf-8');

    const content = readProjectFileAtomic(root, 'test.txt');
    expect(content).toBe('hello world');
  });

  it('readProjectFileAtomic blocks auth-profiles.json', () => {
    const authPath = join(saivageDir, 'auth-profiles.json');
    writeFileSync(authPath, '{"profiles":[]}', 'utf-8');

    expect(() => {
      readProjectFileAtomic(root, '.saivage/auth-profiles.json');
    }).toThrow(/blocked for security reasons/);
  });

  it('readProjectFileAtomic blocks auth-profiles.json with ./ prefix', () => {
    const authPath = join(saivageDir, 'auth-profiles.json');
    writeFileSync(authPath, '{"profiles":[]}', 'utf-8');

    expect(() => {
      readProjectFileAtomic(root, './.saivage/auth-profiles.json');
    }).toThrow(/blocked for security reasons/);
  });

  it('readProjectFileAtomic redacts secrets when opted in', () => {
    writeSaivageConfig({
      apiKey: 'sk-secret-12345',
      name: 'my-project',
      providers: {
        github: { apiToken: 'ghp_abc123' },
      },
    });

    const content = readProjectFileAtomic(root, '.saivage/saivage.yaml', {
      redactSecrets: true,
    });

    // Top-level secret should be redacted
    expect(content).not.toContain('sk-secret-12345');
    expect(content).toContain('[REDACTED]');

    // Non-secret keys should remain
    expect(content).toContain('my-project');
    expect(content).toContain('github');
  });

  it('readProjectFileAtomic does NOT redact when opted out', () => {
    writeSaivageConfig({
      apiKey: 'sk-secret-12345',
      name: 'my-project',
    });

    // Default (no opts) — should NOT redact
    const content = readProjectFileAtomic(root, '.saivage/saivage.yaml');
    expect(content).toContain('sk-secret-12345');
    expect(content).not.toContain('[REDACTED]');
  });

  it('readProjectFileAtomic throws on nonexistent files', () => {
    expect(() => {
      readProjectFileAtomic(root, 'nonexistent.txt');
    }).toThrow(/Failed to read/);
  });

  it('readProjectFileAtomic blocks obsolete saivage.json reads', () => {
    writeSaivageConfig({ name: 'test' });
    writeFileSync(join(saivageDir, 'saivage.json'), '{"name":"test"}', 'utf-8');
    expect(() => readProjectFileAtomic(root, '.saivage/saivage.json')).toThrow(/blocked for security reasons/);
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════

describe('integration edge cases', () => {
  it('readProjectFileAtomic handles .saivage/work paths correctly', () => {
    const workFile = join(saivageWorkDir, 'cards', 'test.json');
    mkdirSync(join(saivageWorkDir, 'cards'), { recursive: true });
    writeFileSync(workFile, '{"ok":true}', 'utf-8');

    // .saivage/work files should not be blocked (only specific paths are)
    const content = readProjectFileAtomic(root, '.saivage/work/cards/test.json');
    expect(content).toBe('{"ok":true}');
  });

  it('blocks current lock namespace paths from reads and writes', async () => {
    const mod = await import('../../src/workspace/index.js');
    expect(mod.isReadBlocked('.saivage/locks/runtime.lock')).toBe(true);
    expect(mod.isWriteBlocked('.saivage/locks/runtime.lock')).toBe(true);
    expect(() => readProjectFileAtomic(root, '.saivage/locks/runtime.lock')).toThrow(/blocked for security reasons/);
  });

  it('redaction does not modify non-secret keys', () => {
    const json = JSON.stringify({
      name: 'my-project',
      description: 'a test project',
      card_count: 5,
    });

    const result = redactTextForOutbound(json);
    expect(result).toContain('my-project');
    expect(result).toContain('a test project');
    expect(result).not.toContain('[REDACTED]');
  });

  it('redaction preserves env var references', () => {
    const json = JSON.stringify({
      apiKey: '${GITHUB_TOKEN}',
      name: 'test',
    });

    const result = redactTextForOutbound(json);
    // Env var references should NOT be redacted
    expect(result).toContain('${GITHUB_TOKEN}');
    expect(result).not.toContain('[REDACTED]');
  });
});
