import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceFileReadModelService } from '../../src/application/read-models/workspace-file-read-model.js';

const records = () => ({
  record: (_cardId: string, _filename: string, _version: number | 'latest' | 'open') => { throw new Error('No records in workspace file tests.'); },
  isActiveCardId: (_cardId: string) => true,
});

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'saivage-workspace-files-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function listedNames(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('files' in body) || !Array.isArray(body.files)) return [];
  return body.files.map((file: unknown) => {
    if (typeof file !== 'object' || file === null || !('name' in file) || typeof file.name !== 'string') throw new Error('Listed file is missing its name.');
    return file.name;
  });
}

describe('WorkspaceFileReadModelService work URLs', () => {
  it('reads process logs and stash files through canonical work URLs', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/work', 'processes', 'proc-1'), { recursive: true });
    mkdirSync(join(root, '.saivage/work', 'tmp', 'stash'), { recursive: true });
    writeFileSync(join(root, '.saivage/work', 'processes', 'proc-1', 'stdout.log'), 'stdout output', 'utf8');
    writeFileSync(join(root, '.saivage/work', 'tmp', 'stash', 'webfetch.txt'), 'stashed output', 'utf8');
    const service = new WorkspaceFileReadModelService(root, records);

    expect(service.readFileContent('work:///processes/proc-1/stdout.log')).toEqual(expect.objectContaining({ body: expect.objectContaining({ path: 'work:///processes/proc-1/stdout.log', content: 'stdout output' }) }));
    expect(service.readFileContent('work:///tmp/stash/webfetch.txt')).toEqual(expect.objectContaining({ body: expect.objectContaining({ path: 'work:///tmp/stash/webfetch.txt', content: 'stashed output' }) }));
  }));

  it('omits and rejects blocked work paths while preserving ordinary work files', () => withRoot((root) => {
    const workRoot = join(root, '.saivage/work/processes/proc-1');
    mkdirSync(workRoot, { recursive: true });
    writeFileSync(join(workRoot, '.env'), 'synthetic blocked value', 'utf8');
    writeFileSync(join(workRoot, 'stdout.log'), 'stdout output', 'utf8');
    symlinkSync('.env', join(workRoot, 'safe-alias.log'));
    const service = new WorkspaceFileReadModelService(root, records);

    const listing = service.listFiles('work:///processes/proc-1');
    expect(listing.body).toEqual(expect.objectContaining({
      files: [expect.objectContaining({ name: 'stdout.log', path: 'work:///processes/proc-1/stdout.log' })],
    }));
    expect(service.readFileContent('work:///processes/proc-1/.env').statusCode).toBe(403);
    expect(service.listFiles('work:///processes/proc-1/.env').statusCode).toBe(403);
    expect(service.readFileContent('work:///processes/proc-1/safe-alias.log').statusCode).toBe(403);
    expect(service.readFileContent('work:///processes/proc-1/stdout.log')).toEqual(expect.objectContaining({ body: expect.objectContaining({ content: 'stdout output', redacted: false, sensitivity: 'normal' }) }));
  }));

  it('lists work directories with work URL child paths while preserving project-relative navigation', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/work', 'processes', 'proc-1'), { recursive: true });
    writeFileSync(join(root, '.saivage/work', 'processes', 'proc-1', 'stdout.log'), 'stdout output', 'utf8');
    writeFileSync(join(root, 'README.md'), 'readme', 'utf8');
    const service = new WorkspaceFileReadModelService(root, records);

    expect(service.listFiles('work:///processes/proc-1')).toEqual(expect.objectContaining({ body: expect.objectContaining({ files: [expect.objectContaining({ path: 'work:///processes/proc-1/stdout.log' })] }) }));
    expect(service.readFileContent('README.md')).toEqual(expect.objectContaining({ body: expect.objectContaining({ path: 'README.md', content: 'readme' }) }));
    expect(service.readFileContent('work:///processes/proc-1/missing.log').statusCode).toBe(404);
  }));

  it('lists the canonical work root and treats it as a directory for content reads', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/work', 'processes'), { recursive: true });
    mkdirSync(join(root, '.saivage/work', 'tmp'), { recursive: true });
    const service = new WorkspaceFileReadModelService(root, records);

    expect(service.listFiles('work:///')).toEqual({
      body: {
        path: 'work:///',
        files: expect.arrayContaining([
          expect.objectContaining({ name: 'processes', path: 'work:///processes', type: 'directory' }),
          expect.objectContaining({ name: 'tmp', path: 'work:///tmp', type: 'directory' }),
        ]),
      },
    });
    expect(service.readFileContent('work:///')).toEqual({ statusCode: 400, body: { error: 'Path is a directory', path: 'work:///' } });
  }));
});

describe('WorkspaceFileReadModelService security admission', () => {
  it('rejects direct blocked paths, including exact and nonexistent lock namespaces', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/locks'), { recursive: true });
    writeFileSync(join(root, '.saivage/locks/runtime.lock'), 'synthetic lock', 'utf8');
    writeFileSync(join(root, '.env'), 'synthetic blocked value', 'utf8');
    const service = new WorkspaceFileReadModelService(root, records);

    expect(service.listFiles('.saivage/locks').statusCode).toBe(403);
    expect(service.readFileContent('.saivage/locks').statusCode).toBe(403);
    expect(service.readFileContent('.saivage/locks/not-created.lock').statusCode).toBe(403);
    expect(service.readFileContent('.env').statusCode).toBe(403);
  }));

  it('omits blocked children and aliases while retaining redacted files and aliases', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/locks'), { recursive: true });
    writeFileSync(join(root, '.env'), 'synthetic blocked value', 'utf8');
    writeFileSync(join(root, '.saivage/saivage.yaml'), 'apiKey: synthetic-redaction-value\nname: visible-name\n', 'utf8');
    writeFileSync(join(root, 'README.md'), 'ordinary', 'utf8');
    symlinkSync('.env', join(root, 'safe-file-alias'));
    symlinkSync('.saivage/locks', join(root, 'safe-directory-alias'));
    symlinkSync('.saivage/saivage.yaml', join(root, 'safe-redacted-alias'));
    const service = new WorkspaceFileReadModelService(root, records);

    const listing = service.listFiles('.');
    expect(listing.body).toEqual(expect.objectContaining({
      files: expect.arrayContaining([
        expect.objectContaining({ name: 'README.md' }),
        expect.objectContaining({ name: 'safe-redacted-alias' }),
      ]),
    }));
    const names = listedNames(listing.body);
    expect(names).not.toContain('.env');
    expect(names).not.toContain('safe-file-alias');
    expect(names).not.toContain('safe-directory-alias');
    expect(service.readFileContent('safe-file-alias').statusCode).toBe(403);
    expect(service.listFiles('safe-directory-alias').statusCode).toBe(403);

    for (const path of ['.saivage/saivage.yaml', 'safe-redacted-alias']) {
      const result = service.readFileContent(path);
      expect(result).toEqual(expect.objectContaining({ body: expect.objectContaining({ path, redacted: true, sensitivity: 'sensitive-redacted' }) }));
      if ('content' in result.body) {
        expect(result.body.content).not.toContain('synthetic-redaction-value');
        expect(result.body.content).toContain('visible-name');
      }
    }
  }));

  it('gives blocking precedence when the lexical redacted path targets a blocked file', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage'), { recursive: true });
    writeFileSync(join(root, '.env'), 'synthetic blocked value', 'utf8');
    symlinkSync('../.env', join(root, '.saivage/saivage.yaml'));
    const service = new WorkspaceFileReadModelService(root, records);

    expect(service.readFileContent('.saivage/saivage.yaml').statusCode).toBe(403);
  }));

  it('rejects file and directory aliases whose targets are outside the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'saivage-workspace-outside-'));
    try {
      withRoot((root) => {
        writeFileSync(join(outside, 'outside.txt'), 'outside synthetic value', 'utf8');
        mkdirSync(join(outside, 'directory'));
        symlinkSync(join(outside, 'outside.txt'), join(root, 'outside-file-alias'));
        symlinkSync(join(outside, 'directory'), join(root, 'outside-directory-alias'));
        const service = new WorkspaceFileReadModelService(root, records);

        expect(service.readFileContent('outside-file-alias').statusCode).toBe(403);
        expect(service.listFiles('outside-directory-alias').statusCode).toBe(403);
        const listing = service.listFiles('.');
        const names = listedNames(listing.body);
        expect(names).not.toContain('outside-file-alias');
        expect(names).not.toContain('outside-directory-alias');
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
