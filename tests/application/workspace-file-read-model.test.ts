import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceFileReadModelService } from '../../src/application/read-models/workspace-file-read-model.js';

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'saivage-workspace-files-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('WorkspaceFileReadModelService work URLs', () => {
  it('reads process logs and stash files through canonical work URLs', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage-work', 'processes', 'proc-1'), { recursive: true });
    mkdirSync(join(root, '.saivage-work', 'tmp', 'stash'), { recursive: true });
    writeFileSync(join(root, '.saivage-work', 'processes', 'proc-1', 'stdout.log'), 'stdout output', 'utf8');
    writeFileSync(join(root, '.saivage-work', 'tmp', 'stash', 'webfetch.txt'), 'stashed output', 'utf8');
    const service = new WorkspaceFileReadModelService(root);

    expect(service.readFileContent('work:///processes/proc-1/stdout.log')).toEqual(expect.objectContaining({ body: expect.objectContaining({ path: 'work:///processes/proc-1/stdout.log', content: 'stdout output' }) }));
    expect(service.readFileContent('work:///tmp/stash/webfetch.txt')).toEqual(expect.objectContaining({ body: expect.objectContaining({ path: 'work:///tmp/stash/webfetch.txt', content: 'stashed output' }) }));
  }));

  it('lists work directories with work URL child paths while preserving project-relative navigation', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage-work', 'processes', 'proc-1'), { recursive: true });
    writeFileSync(join(root, '.saivage-work', 'processes', 'proc-1', 'stdout.log'), 'stdout output', 'utf8');
    writeFileSync(join(root, 'README.md'), 'readme', 'utf8');
    const service = new WorkspaceFileReadModelService(root);

    expect(service.listFiles('work:///processes/proc-1')).toEqual(expect.objectContaining({ body: expect.objectContaining({ files: [expect.objectContaining({ path: 'work:///processes/proc-1/stdout.log' })] }) }));
    expect(service.readFileContent('README.md')).toEqual(expect.objectContaining({ body: expect.objectContaining({ path: 'README.md', content: 'readme' }) }));
    expect(service.readFileContent('work:///processes/proc-1/missing.log').statusCode).toBe(404);
  }));
});
