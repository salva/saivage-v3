import { describe, expect, it } from '@jest/globals';

import { testRecordDefinition, testRecordDefinitions } from '../helpers/record-definitions.js';
import { resolveRecordReadTarget, resolveRecordWriteTarget, scopedPathResolvers, type ResolveScopedPathContext } from '../../src/workspace/scoped-path-schemes.js';
import { resolveScopedPath } from '../../src/workspace/vfs.js';
import { AuthoredRecordNotFoundError } from '../../src/persistence/authored-record-files.js';

function fail(message: string): Error {
  const error = new Error(message);
  error.name = 'WorkspaceToolInputError';
  return error;
}

function ctx(): ResolveScopedPathContext {
  return {
    projectRoot: '/tmp/saivage-workspace-resolver-test',
    agent: { cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', agentName: 'planner' },
    fail,
    records:{record:()=>{throw new AuthoredRecordNotFoundError();},definition:(_cardId,filename)=>testRecordDefinition(filename)},
  };
}

async function expectWorkspaceToolInputError(action: () => unknown): Promise<void> {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('WorkspaceToolInputError');
    return;
  }
  throw new Error('Expected resolver to throw.');
}

describe('scoped path resolvers', () => {
  it('classifies unsupported write record slots through the fail callback', async () => {
    await expectWorkspaceToolInputError(() => resolveRecordWriteTarget(ctx(), 'record:///bogus.md?card=card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa&v=next'));
    await expectWorkspaceToolInputError(() => resolveRecordWriteTarget(ctx(), 'record:///card.json?card=card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa&v=next'));
  });

  it('classifies malformed write record URLs through the fail callback', async () => {
    await expectWorkspaceToolInputError(() => resolveRecordWriteTarget(ctx(), 'record://brief.md'));
  });

  it('classifies unsupported read record slots through the fail callback', async () => {
    await expectWorkspaceToolInputError(() => resolveRecordReadTarget(ctx(), 'record:///bogus.md?card=card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa&v=latest'));
    await expectWorkspaceToolInputError(() => resolveRecordReadTarget(ctx(), 'record:///card.json?card=card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa&v=latest'));
    const vfsContext = {...ctx(),records:{...ctx().records!,definitions:()=>testRecordDefinitions()}};
    await expectWorkspaceToolInputError(() => resolveScopedPath(vfsContext, 'record:///bogus.md', 'read'));
    await expectWorkspaceToolInputError(() => resolveScopedPath(vfsContext, 'record:///card.json', 'read'));
  });

  it('classifies malformed read record URLs through the fail callback', async () => {
    await expectWorkspaceToolInputError(() => resolveRecordReadTarget(ctx(), 'record://brief.md'));
  });

  it('keeps a syntactically valid record root semantically invalid', async () => {
    await expectWorkspaceToolInputError(() => resolveRecordWriteTarget(ctx(), 'record:///'));
    await expectWorkspaceToolInputError(() => resolveRecordReadTarget(ctx(), 'record:///'));
  });

  it('keeps a syntactically valid tmp root semantically invalid', async () => {
    await expectWorkspaceToolInputError(() => scopedPathResolvers.tmp(ctx(), 'tmp:///', 'read'));
  });

  it('resolves adjacent-dot segments and rejects exact parent segments for filesystem schemes', () => {
    const context = ctx();
    const adjacentPaths = [
      ['project', () => scopedPathResolvers.project(context, 'project:///docs/v1..v2')],
      ['tmp', () => scopedPathResolvers.tmp(context, 'tmp:///card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/v1..v2', 'read')],
      ['work', () => scopedPathResolvers.work(context, 'work:///logs/v1..v2', 'read')],
      ['system', () => scopedPathResolvers.system(context, 'system:///opt/v1..v2')],
    ] as const;
    for (const [kind, resolvePath] of adjacentPaths) {
      expect(resolvePath()).toMatchObject({ kind });
    }

    const rejectedPaths = [
      () => scopedPathResolvers.project(context, 'project:///docs/../file'),
      () => scopedPathResolvers.project(context, 'project:///docs/%2E%2E/file'),
      () => scopedPathResolvers.tmp(context, 'tmp:///card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/../file', 'read'),
      () => scopedPathResolvers.tmp(context, 'tmp:///card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/%2E%2E/file', 'read'),
      () => scopedPathResolvers.work(context, 'work:///logs/../file', 'read'),
      () => scopedPathResolvers.work(context, 'work:///logs/%2E%2E/file', 'read'),
      () => scopedPathResolvers.system(context, 'system:///opt/../file'),
      () => scopedPathResolvers.system(context, 'system:///opt/%2E%2E/file'),
    ];
    for (const resolvePath of rejectedPaths) expect(resolvePath).toThrow();
  });

  it('uses the selected card type compiled record definitions', () => {
    expect(testRecordDefinitions().map(({filename})=>filename)).toEqual(['brief.md','status.md','review.md']);
    for (const filename of ['brief.md', 'status.md', 'review.md']) expect(testRecordDefinition(filename).filename).toBe(filename);
  });

  it('keeps low-level record slot helpers as plain Error throwers', () => {
    expect(() => testRecordDefinition('bogus.md')).toThrow(Error);
    expect(() => testRecordDefinition('card.json')).toThrow(Error);
    expect(() => testRecordDefinition('nested/brief.md')).toThrow(Error);
    try {
      testRecordDefinition('bogus.md');
    } catch (error) {
      expect((error as Error).name).toBe('AuthoredRecordNotFoundError');
    }
  });

  it('translates only concrete authored-record absence into a tool-facing rejection', async () => {
    for (const version of ['latest', 'next', '1']) {
      const absent = ctx();
      await expectWorkspaceToolInputError(() => resolveRecordReadTarget(absent, `record:///brief.md?card=card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa&v=${version}`));

      const hostile = new Error(`HOSTILE_STRICT_READ_${version}`);
      const failed = { ...ctx(), records: { ...ctx().records!, record: () => { throw hostile; } } };
      expect(() => resolveRecordReadTarget(failed, `record:///brief.md?card=card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa&v=${version}`)).toThrow(hostile);
    }
  });
});
