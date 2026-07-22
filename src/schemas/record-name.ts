import { z } from 'zod';

export const recordNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}\.md$/u, 'Expected a lowercase Markdown record filename with no path segments.');
export type RecordName = z.infer<typeof recordNameSchema>;

export function parseRecordName(value: unknown): RecordName {
  return recordNameSchema.parse(value);
}

export function recordStreamFilename(name: RecordName): string {
  return `${name.slice(0, -'.md'.length)}.jsonl`;
}
