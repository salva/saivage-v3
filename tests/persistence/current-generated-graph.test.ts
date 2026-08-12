import { afterEach, describe, expect, it } from '@jest/globals';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeConfiguredOptionalState, validateCurrentGeneratedGraph } from '../../src/persistence/current-generated-graph.js';
import { appLogFile, cardConversationVersionFile, cardRecordVersionIndexFile } from '../../src/persistence/layout.js';
import { readConversationCatalog } from '../../src/persistence/conversation-file.js';
import { initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { testRecordDefinition } from '../helpers/record-definitions.js';

const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
describe('current generated graph initialization',()=>{
  it('recreates deterministic optional authority, repairs only initialization-owned tails, then validates current graph',()=>{
    const root=mkdtempSync(join(tmpdir(),'saivage-current-graph-'));roots.push(root);initProjectTree(root);
    const optional=cardRecordVersionIndexFile(root,'project',testRecordDefinition('status.md','project'));unlinkSync(optional);
    const catalog=readConversationCatalog(root,'agent:planner:project');const path=cardConversationVersionFile(root,'project','planner',catalog.versions.at(-1)?.filename??'missing');
    if(catalog.currentVersion!==null)appendFileSync(path,'{"bad":true}\n');
    initializeConfiguredOptionalState(root,TEST_WORKFLOWS);
    expect(readFileSync(optional,'utf8')).toContain('authored-record-version-index');
    validateCurrentGeneratedGraph(root,TEST_WORKFLOWS);
  });

  it('repairs a non-versioned app-log suffix only during initialization',()=>{
    const root=mkdtempSync(join(tmpdir(),'saivage-current-app-log-'));roots.push(root);initProjectTree(root);
    const path=appLogFile(root);mkdirSync(join(root,'.saivage','logs'));appendFileSync(path,'partial');
    expect(()=>initializeConfiguredOptionalState(root,TEST_WORKFLOWS)).not.toThrow();
    expect(readFileSync(path)).toHaveLength(0);
  });
});
