import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();

function sourceFiles(directory = join(root, 'src')): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

function filesContaining(pattern: RegExp): string[] {
  return sourceFiles().filter((path) => pattern.test(readFileSync(path, 'utf8'))).map((path) => relative(root, path)).sort();
}

describe('durable writer inventory', () => {
  it('keeps the replacement primitive private to the owning stores and lifecycle lock', () => {
    expect(filesContaining(/\bdurablyReplaceFile\(/u)).toEqual([
      'src/auth/auth-profile-store.ts',
      'src/config/config-file-store.ts',
      'src/persistence/durable-file-replacement.ts',
      'src/persistence/growing-file.ts',
      'src/persistence/project-identity-store.ts',
      'src/persistence/project-store-repository.ts',
      'src/runtime/actors/actor-recovery.ts',
      'src/runtime/actors/snapshots.ts',
      'src/runtime/lock.ts',
      'src/runtime/state.ts',
    ]);
    expect(readFileSync(join(root, 'src/persistence/index.ts'), 'utf8')).not.toMatch(/durablyReplaceFile|publishDirectory/u);
  });

  it('assigns each growing target to its one owning store', () => {
    expect(filesContaining(/\b(?:appendEnvelope|publishFirstEnvelope)\(/u)).toEqual([
      'src/agents/candidate-availability-store.ts',
      'src/persistence/app-log.ts',
      'src/persistence/conversation-store.ts',
      'src/persistence/growing-file.ts',
    ]);
  });

  it('has no production script repository writer or alternate bootstrap runtime writer', () => {
    expect(filesContaining(/new AuthProfileRepository/u)).toEqual(['src/server/composition/server-services.ts']);
    expect(readFileSync(join(root, 'src/persistence/project-store-repository.ts'), 'utf8')).not.toMatch(/durablyReplaceFile\(runtimePath/u);
    expect(sourceFiles(join(root, 'src/scripts'))).toEqual([]);
  });

  it('contains no generic persistence callback or replay/CAS contract', () => {
    for (const path of sourceFiles(join(root, 'src/persistence'))) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/\b(?:mutate|request|apply)\s*\([^)]*=>/u);
      expect(source).not.toMatch(/\b(?:sourceDigest|sourceVersion|generation|idempotenc|transaction)\b/iu);
    }
  });
});
