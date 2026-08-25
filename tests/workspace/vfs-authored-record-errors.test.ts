import { describe, expect, it } from '@jest/globals';

import { listScopedPath,resolveScopedPath } from '../../src/workspace/vfs.js';
import { AuthoredRecordNotFoundError } from '../../src/persistence/authored-record-files.js';
import { testRecordDefinition, testRecordDefinitions } from '../helpers/record-definitions.js';

const fail = (message: string) => new Error(message);
const records=(read:()=>never)=>({currentOrNull:read,historical:read,definition:(_cardId:string,filename:string)=>testRecordDefinition(filename),definitions:()=>testRecordDefinitions()});

describe('VFS authored-record summaries', () => {
  it('projects only concrete absence as empty metadata and propagates strict failures', async () => {
    const absent = await listScopedPath({ projectRoot: '/tmp', agent: { cardId: 'project', agentName: 'analyst' }, fail, records: records(() => { throw new AuthoredRecordNotFoundError(); }) }, 'record:///project');
    expect(absent.kind).toBe('records');
    if (absent.kind === 'records') expect(absent.records.every((record) => record.state === 'absent' && record.head_version === null)).toBe(true);

    const hostile = new Error('HOSTILE_VFS_RECORD_READ');
    await expect(listScopedPath({ projectRoot: '/tmp', agent: { cardId: 'project', agentName: 'analyst' }, fail, records: records(() => { throw hostile; }) }, 'record:///project')).rejects.toBe(hostile);
  });

  it('resolves a valid absent current target with deterministic metadata and empty content',()=>{
    const reader={...records(()=>{throw new AuthoredRecordNotFoundError();}),definition:()=>({filename:'notes.md' as const,format:'markdown' as const,schema:'authored-record.v1',bootstrap:false,declared:false})};
    expect(resolveScopedPath({projectRoot:'/tmp',agent:{cardId:'project',agentName:'analyst'},fail,records:reader},'record:///notes.md?card=project','read')).toMatchObject({kind:'record',recordKind:'document',cardId:'project',filename:'notes.md',format:'markdown',schema:'authored-record.v1',state:'absent',headVersion:null,versionUrl:null,content:'',committedAt:null,size:0,currentSelection:true});
  });
});
