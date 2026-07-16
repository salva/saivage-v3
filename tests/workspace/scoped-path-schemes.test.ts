import { describe, expect, it } from '@jest/globals';

import { exposedRecordSlotDefinitionForFilename } from '../../src/runtime/records/record-slots.js';
import { resolveRecordReadTarget, resolveRecordWriteTarget, scopedPathResolvers, type ResolveScopedPathContext } from '../../src/workspace/scoped-path-schemes.js';

function fail(message: string): Error {
  const error = new Error(message);
  error.name = 'WorkspaceToolInputError';
  return error;
}

function ctx(): ResolveScopedPathContext {
  return {
    projectRoot: '/tmp/saivage-workspace-resolver-test',
    agent: { cardId: '11111111-1111-4111-8111-111111111111', agentRole: 'planner' },
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
    await expectWorkspaceToolInputError(() => resolveRecordWriteTarget(ctx(), 'record:///bogus.md?card=11111111-1111-4111-8111-111111111111&v=next'));
  });

  it('classifies malformed write record URLs through the fail callback', async () => {
    await expectWorkspaceToolInputError(() => resolveRecordWriteTarget(ctx(), 'record://brief.md'));
  });

  it('classifies unsupported read record slots through the fail callback', async () => {
    await expectWorkspaceToolInputError(() => resolveRecordReadTarget(ctx(), 'record:///bogus.md?card=11111111-1111-4111-8111-111111111111&v=latest'));
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

  it('keeps low-level record slot helpers as plain Error throwers', () => {
    expect(() => exposedRecordSlotDefinitionForFilename('bogus.md')).toThrow(Error);
    try {
      exposedRecordSlotDefinitionForFilename('bogus.md');
    } catch (error) {
      expect((error as Error).name).toBe('Error');
    }
  });
});
