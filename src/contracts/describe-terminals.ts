import type { ZodTypeAny } from 'zod';
import type { ContractTerminalDescriptor } from './contract.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import { jsonSchemaToProse } from './json-schema-to-prose.js';

export function describeTerminals(
  terminals: readonly ContractTerminalDescriptor[],
): string {
  return terminals
    .map((t, i) => {
      const schema = zodToJsonSchemaMini(t.schema as ZodTypeAny);
      return `${i + 1}. \`${t.name}\` - ${t.description}\n\n${jsonSchemaToProse(schema)}`;
    })
    .join('\n\n');
}
