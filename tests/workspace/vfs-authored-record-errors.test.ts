import { describe, expect, it } from '@jest/globals';

import { listScopedPath } from '../../src/workspace/vfs.js';
import { AuthoredRecordNotFoundError } from '../../src/persistence/authored-record-files.js';
import { testRecordDefinition, testRecordDefinitions } from '../helpers/record-definitions.js';

const fail = (message: string) => new Error(message);
const records=(read:()=>never)=>({record:read,definition:(_cardId:string,filename:string)=>testRecordDefinition(filename),definitions:()=>testRecordDefinitions()});

describe('VFS authored-record summaries', () => {
  it('projects only concrete absence as empty metadata and propagates strict failures', async () => {
    const absent = await listScopedPath({ projectRoot: '/tmp', agent: { cardId: 'project', agentName: 'analyst' }, fail, records: records(() => { throw new AuthoredRecordNotFoundError(); }) }, 'record:///project');
    expect(absent.kind).toBe('records');
    if (absent.kind === 'records') expect(absent.records.every((record) => record.latest === null)).toBe(true);

    const hostile = new Error('HOSTILE_VFS_RECORD_READ');
    await expect(listScopedPath({ projectRoot: '/tmp', agent: { cardId: 'project', agentName: 'analyst' }, fail, records: records(() => { throw hostile; }) }, 'record:///project')).rejects.toBe(hostile);
  });
});
