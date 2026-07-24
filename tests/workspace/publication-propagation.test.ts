import { describe, expect, it } from '@jest/globals';

import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { resolveRecordReadTarget } from '../../src/workspace/scoped-path-schemes.js';
import { listScopedPath } from '../../src/workspace/vfs.js';
import { WorkspaceFileReadModelService } from '../../src/application/read-models/workspace-file-read-model.js';

const definition = { filename: 'status.md', bootstrap: false, writers: ['planner'], format: 'markdown', schema: null } as never;

describe('publication uncertainty across scoped record projections', () => {
  it('preserves the same instance before scoped-path not-found conversion', () => {
    const publication = new PublicationOutcomeUnknownError();
    const records = { definition: () => definition, record: () => { throw publication; } };
    let thrown: unknown;
    try { resolveRecordReadTarget({ projectRoot: '/', records, agent: { cardId: 'project', agentName: 'planner' }, fail: (message) => new Error(message) }, 'record:///status.md?card=project'); }
    catch (error) { thrown = error; }
    expect(thrown).toBe(publication);
  });

  it('preserves the same instance before VFS latest-record null projection', async () => {
    const publication = new PublicationOutcomeUnknownError();
    const records = { definitions: () => [definition], definition: () => definition, record: () => { throw publication; } };
    await expect(listScopedPath({ projectRoot: '/', records, agent: { cardId: 'project', agentName: 'planner' }, fail: (message) => new Error(message) }, 'record:///project')).rejects.toBe(publication);
  });

  it('preserves the same instance before operator Files record response conversion', () => {
    const publication = new PublicationOutcomeUnknownError();
    const records = { definition: () => { throw publication; } };
    const service = new WorkspaceFileReadModelService('/', () => records as never, { path: '/config' } as never);
    let thrown: unknown;
    try { service.readFileContent('record:///status.md?card=project'); } catch (error) { thrown = error; }
    expect(thrown).toBe(publication);
  });
});
