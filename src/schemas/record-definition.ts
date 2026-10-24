import type { RecordName } from './record-name.js';

/** The shared definition for an undeclared authored Markdown record. */
export function genericRecordDefinition(name: RecordName) {
  return Object.freeze({
    name,
    format: 'markdown' as const,
    schema: 'authored-record.v1',
    bootstrap: false,
    declared: false,
    initialization: null,
  });
}
