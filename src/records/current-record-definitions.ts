import type { AgentRole } from '../schemas/index.js';
import { parseRecordName, type RecordName } from '../schemas/record-name.js';
import type { AuthoredRecordSlot, RecordVersionArtifact } from '../persistence/canonical-record-artifacts.js';

export type RecordDefinition = Readonly<{
  filename: RecordName;
  slot: AuthoredRecordSlot;
  writers: readonly AgentRole[];
  format: RecordVersionArtifact['format'];
  schema: string;
  bootstrap: boolean;
}>;

const definitions: readonly RecordDefinition[] = Object.freeze([
  Object.freeze({ filename: parseRecordName('brief.md'), slot: 'brief', writers: Object.freeze(['analyst', 'planner'] as AgentRole[]), format: 'markdown', schema: 'record.brief.markdown.v1', bootstrap: true }),
  Object.freeze({ filename: parseRecordName('status.md'), slot: 'status', writers: Object.freeze(['planner', 'executor'] as AgentRole[]), format: 'markdown', schema: 'record.status.markdown.v1', bootstrap: false }),
  Object.freeze({ filename: parseRecordName('review.md'), slot: 'review', writers: Object.freeze(['reviewer'] as AgentRole[]), format: 'markdown', schema: 'record.review.markdown.v1', bootstrap: false }),
]);

const definitionsByFilename = new Map(definitions.map((definition) => [definition.filename, definition]));
const definitionsBySlot = new Map(definitions.map((definition) => [definition.slot, definition]));

export function currentRecordDefinitionForFilename(filename: string): RecordDefinition {
  const name = parseRecordName(filename);
  const definition = definitionsByFilename.get(name);
  if (!definition) throw new Error(`Unsupported record slot '${filename}'.`);
  return definition;
}

export function currentRecordDefinitionForSlot(slot: AuthoredRecordSlot): RecordDefinition {
  const definition = definitionsBySlot.get(slot);
  if (!definition) throw new Error(`Unsupported record slot '${slot}'.`);
  return definition;
}

export function currentRecordDefinitions(): readonly RecordDefinition[] {
  return definitions;
}
