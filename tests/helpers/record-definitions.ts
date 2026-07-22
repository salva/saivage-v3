import type { CardType } from '../../src/schemas/index.js';
import type { RecordDefinition } from '../../src/records/record-definition.js';
import { TEST_WORKFLOWS } from './canonical-project.js';
import { AuthoredRecordNotFoundError } from '../../src/persistence/authored-record-files.js';

export function testRecordDefinitions(cardType:CardType='project'):RecordDefinition[]{
  return [...TEST_WORKFLOWS.cardTypes.get(cardType)!.records.values()].map((definition)=>({filename:definition.name,writers:definition.writers,format:definition.format,schema:definition.schema,bootstrap:definition.bootstrap}));
}
export function testRecordDefinition(filename:string,cardType:CardType='project'):RecordDefinition{
  const definition=testRecordDefinitions(cardType).find((candidate)=>candidate.filename===filename);
  if(!definition)throw new AuthoredRecordNotFoundError();
  return definition;
}
