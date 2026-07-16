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

describe('availability and auth ownership inventory', () => {
  it('contains no durable candidate-availability owner or file contract', () => {
    expect(filesContaining(/CandidateAvailabilityStore|provider-availability\.jsonl|candidate-availability-store/u)).toEqual([]);
    expect(filesContaining(/new MemoryCandidateAvailability/u)).toEqual(['src/application/runtime-composition.ts']);
  });

  it('contains no auth repository, revision, mode, health, or refresh service', () => {
    expect(filesContaining(/AuthProfileRepository|AuthProfileProjection|AuthProfileConflictError|authProfileRevision|AUTH_PROFILE_FILE_MODE|replaceRefreshedAuthProfile/u)).toEqual([]);
    expect(readFileSync(join(root, 'src/auth/index.ts'), 'utf8')).toMatch(/readAuthProfile, readAuthProfiles, replaceAuthProfiles/u);
  });
});
