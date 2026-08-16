import type { CardTypeName } from '../../src/schemas/index.js';
import type { RecordDefinition } from '../../src/records/record-definition.js';
import { TEST_WORKFLOWS } from './canonical-project.js';
import { AuthoredRecordNotFoundError } from '../../src/persistence/authored-record-files.js';

export function testRecordDefinitions(cardType:CardTypeName='project'):RecordDefinition[]{
  const workflow=TEST_WORKFLOWS.cardTypes.get(cardType);if(!workflow)throw new Error(`Missing test workflow '${cardType}'.`);return [...workflow.records.values()].map((definition)=>({filename:definition.name,format:definition.format,schema:definition.schema,bootstrap:definition.bootstrap,declared:true}));
}
export function testRecordDefinition(filename:string,cardType:CardTypeName='project'):RecordDefinition{
  const definition=testRecordDefinitions(cardType).find((candidate)=>candidate.filename===filename);
  if(!definition)throw new AuthoredRecordNotFoundError();
  return definition;
}
