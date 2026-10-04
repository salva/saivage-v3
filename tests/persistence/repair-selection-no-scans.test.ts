import { afterEach, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { inspectCardSelection, readCardRepairParent, restoreCardSelection } from '../../src/persistence/card-files.js';
import { inspectAuthoredRecordSelection, restoreAuthoredRecordSelection } from '../../src/persistence/authored-record-files.js';
import { appendConversationBatch, inspectConversationIndex, inspectConversationSegment } from '../../src/persistence/conversation-file.js';
import { cardHeadFile, cardPreviousHeadFile, cardRecordPreviousHeadFile, cardConversationVersionIndexFile } from '../../src/persistence/layout.js';
import { TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks(); syncBuiltinESMExports();
  while (roots.length) fs.rmSync(roots.pop()!, {recursive:true, force:true});
});

it('repair primitives use only supplied selectors and exact selected paths, without enumeration or inspection write descriptors', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'repair-no-scans-')); roots.push(root); initProjectTree(root);
  const cards = new CardService(root);
  const card = cards.create({type:'code', parent:'project', title:'first', bootstrap_content:'brief', priority:0, urgency:'normal', created_by:'analyst', depends_on:[]});
  cards.editCard(card.id, {title:'second'});
  cards.acceptRecord(card.id, 'status.md', 'accepted', 'analyst'); cards.openRecord(card.id, 'status.md');
  const definition = {filename:'status.md', format:'markdown' as const, schema:'work-status.v1', bootstrap:false, declared:true};
  appendConversationBatch({projectRoot:root}, [{id:'text', session_id:'agent:planner:project', role:'assistant', kind:'text', content:'hello', timestamp:'2026-10-04T00:00:00.000Z', context_policy:TEXT_ROW_POLICY, round_id:`r-assistant-${'0'.repeat(32)}`, message_index:1, block_index:0}]);
  const cardBytes = fs.readFileSync(cardPreviousHeadFile(root, card.id));
  const recordBytes = fs.readFileSync(cardRecordPreviousHeadFile(root, card.id, definition));
  const indexBytes = fs.readFileSync(cardConversationVersionIndexFile(root, 'project', 'planner'));
  const scan = jest.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('directory scan'); });
  const openDirectory = jest.spyOn(fs, 'opendirSync').mockImplementation(() => { throw new Error('directory scan'); });
  const originalOpen = fs.openSync;
  const open = jest.spyOn(fs, 'openSync').mockImplementation((path, flags, ...rest) => {
    if (flags !== 'r' && flags !== fs.constants.O_RDONLY) throw new Error('inspection write descriptor');
    return originalOpen(path, flags, ...rest);
  });
  syncBuiltinESMExports();
  expect(readCardRepairParent(root, card.id)?.id).toBe('project');
  const selectedCard = inspectCardSelection(root, card.id, cardBytes);
  const selectedRecord = inspectAuthoredRecordSelection(root, card.id, definition, recordBytes);
  const index = inspectConversationIndex(root, 'agent:planner:project', indexBytes);
  expect(inspectConversationSegment(root, 'agent:planner:project', index)?.projection.rows).toHaveLength(1);
  expect(open).toHaveBeenCalled(); open.mockRestore(); syncBuiltinESMExports();
  restoreCardSelection(root, card.id, selectedCard.selection, 'replacement');
  restoreAuthoredRecordSelection(root, card.id, definition, selectedRecord.head, 'replacement');
  expect(scan).not.toHaveBeenCalled(); expect(openDirectory).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(cardHeadFile(root, card.id), 'utf8')).head_id).not.toBe(selectedCard.selection.head_id);
});
