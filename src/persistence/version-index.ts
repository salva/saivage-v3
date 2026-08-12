import { z } from 'zod';

import { positiveSafeIntegerSchema } from '../schemas/index.js';

export const uuidV4Schema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

export const jsonVersionFilenameSchema = z.string().regex(
  /^[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/,
);

export const jsonlVersionFilenameSchema = z.string().regex(
  /^[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/,
);

export function versionFilename(version: number, id: string, extension: 'json' | 'jsonl'): string {
  positiveSafeIntegerSchema.parse(version);
  uuidV4Schema.parse(id);
  return `${version}-${id}.${extension}`;
}

export function validateHeadFields(
  value: { readonly versions: readonly { readonly version: number; readonly filename: string }[]; readonly current_version: number | null; readonly current_filename: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.versions.length === 0) {
    if (value.current_version !== null || value.current_filename !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An empty version catalog requires null current fields.' });
    }
    return;
  }
  const filenames = new Set<string>();
  for (const [index, entry] of value.versions.entries()) {
    if (entry.version !== index + 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Version catalog entries must be contiguous and ascending.', path: ['versions', index, 'version'] });
    const prefix = Number(entry.filename.slice(0, entry.filename.indexOf('-')));
    if (prefix !== entry.version) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Version filename prefix must equal entry version.', path: ['versions', index, 'filename'] });
    if (filenames.has(entry.filename)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Version filenames must be unique.', path: ['versions', index, 'filename'] });
    filenames.add(entry.filename);
  }
  const head = value.versions.at(-1)!;
  if (value.current_version !== head.version || value.current_filename !== head.filename) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Current version and filename must equal the catalog head.' });
  }
}

export function versionHeadFieldsSchema<Entry extends z.ZodType<{ version: number; filename: string }>>(entrySchema: Entry) {
  return z.object({
    versions: z.array(entrySchema),
    current_version: positiveSafeIntegerSchema.nullable(),
    current_filename: z.string().nullable(),
  }).strict().superRefine(validateHeadFields);
}
