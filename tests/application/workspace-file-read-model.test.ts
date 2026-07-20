import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
