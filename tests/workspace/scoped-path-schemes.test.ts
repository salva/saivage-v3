import { describe, expect, it } from '@jest/globals';

import { recordSlotDefinitionForFilename, recordSlotDefinitions } from '../../src/runtime/records/record-slots.js';
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
    agent: { cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', agentRole: 'planner' },
    fail,
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
    const vfsContext = { ...ctx(), records: { record: () => { throw new AuthoredRecordNotFoundError(); } } };
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

  it('defines exactly the three authored record slots', () => {
    expect(recordSlotDefinitions()).toEqual([
      { filename: 'brief.md', slot: 'brief', writers: ['analyst', 'planner'], format: 'markdown', schema: 'record.brief.markdown.v1' },
      { filename: 'status.md', slot: 'status', writers: ['planner', 'executor'], format: 'markdown', schema: 'record.status.markdown.v1' },
      { filename: 'review.md', slot: 'review', writers: ['reviewer'], format: 'markdown', schema: 'record.review.markdown.v1' },
    ]);
    for (const filename of ['brief.md', 'status.md', 'review.md']) expect(recordSlotDefinitionForFilename(filename).filename).toBe(filename);
  });

  it('keeps low-level record slot helpers as plain Error throwers', () => {
    expect(() => recordSlotDefinitionForFilename('bogus.md')).toThrow(Error);
    expect(() => recordSlotDefinitionForFilename('card.json')).toThrow(Error);
    expect(() => recordSlotDefinitionForFilename('nested/brief.md')).toThrow(Error);
    try {
      recordSlotDefinitionForFilename('bogus.md');
    } catch (error) {
      expect((error as Error).name).toBe('Error');
    }
  });

  it('translates only concrete authored-record absence into a tool-facing rejection', async () => {
    for (const version of ['latest', 'next', '1']) {
      const absent = { ...ctx(), records: { record: () => { throw new AuthoredRecordNotFoundError(); } } };
      await expectWorkspaceToolInputError(() => resolveRecordReadTarget(absent, `record:///brief.md?card=card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa&v=${version}`));

      const hostile = new Error(`HOSTILE_STRICT_READ_${version}`);
      const failed = { ...ctx(), records: { record: () => { throw hostile; } } };
      expect(() => resolveRecordReadTarget(failed, `record:///brief.md?card=card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa&v=${version}`)).toThrow(hostile);
    }
  });
});
