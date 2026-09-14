import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOversightNotificationPort } from '../../src/application/oversight-notification-port.js';
import { CardService, initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('Oversight notification authority',()=>{
  it('requires the active check signal and admits only capability-derived planning targets',async()=>{
    const root=mkdtempSync(join(tmpdir(),'oversight-notification-port-'));roots.push(root);initProjectTree(root);
    const cards=new CardService(root);const leaf=cards.create({type:'code',parent:'project',title:'leaf',bootstrap_content:'work',tags:[],priority:0,urgency:'normal',created_by:'planner',depends_on:[],related:[]});
    const signal=new AbortController().signal;const assertEffectAdmission=jest.fn((candidate:AbortSignal)=>{if(candidate!==signal)throw new Error('foreign signal');});
    const submitNotification=jest.fn(async(cardId:string)=>({queued:true as const,cardId,notificationId:'notification-1',interruption:{status:'not_requested' as const}}));
    const port=createOversightNotificationPort({oversight:{assertEffectAdmission},cards,workflows:TEST_WORKFLOWS,submitNotification:submitNotification as never});
    const notification={id:'11111111-1111-4111-8111-111111111111',kind:'finding',body:'evidence',created_at:'2026-09-14T00:00:00.000Z',from:'oversight'} as never;
    await expect(port(leaf.id,notification,'normal',signal)).resolves.toEqual({queued:false,reason:'planning_ineligible',cardId:leaf.id});
    expect(submitNotification).not.toHaveBeenCalled();
    await expect(port('project',notification,'normal',signal)).resolves.toMatchObject({queued:true,cardId:'project'});
    expect(submitNotification).toHaveBeenCalledTimes(1);
    await expect(port('project',notification,'normal',new AbortController().signal)).rejects.toThrow('foreign signal');
  });
});
