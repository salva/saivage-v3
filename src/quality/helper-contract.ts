import { z } from 'zod';
import {
  javascriptQualityConfigSchema,
  typescriptQualityConfigSchema,
  pythonQualityConfigSchema,
  uuidV4Schema,
} from '../schemas/index.js';

const paths = z
  .object({
    cwd: z.string(),
    native_config: z.string(),
    eslint_module: z.string().nullable(),
    typescript_eslint_module: z.string().nullable(),
    typescript_module: z.string().nullable(),
    tsconfig: z.string().nullable(),
    files: z.array(z.string()).max(2000),
    cache: z.string(),
  })
  .strict();
const common = { invocation: uuidV4Schema, projectRoot: z.string(), paths };
export const qualityHelperRequestSchema = z.discriminatedUnion('language', [
  z
    .object({ ...common, language: z.literal('javascript'), config: javascriptQualityConfigSchema })
    .strict(),
  z
    .object({ ...common, language: z.literal('typescript'), config: typescriptQualityConfigSchema })
    .strict(),
  z
    .object({ ...common, language: z.literal('python'), config: pythonQualityConfigSchema })
    .strict(),
]);
const position = z
  .object({ line: z.number().int().nonnegative(), column: z.number().int().nonnegative() })
  .strict();
export const qualityHelperResultSchema = z
  .object({
    invocation: uuidV4Schema,
    outcome: z.enum(['clean', 'findings', 'analysis_failed']),
    native_exit: z.number().int().nullable(),
    tool_versions: z.record(z.string()),
    diagnostic: z.string().nullable(),
    // Native payload was decoded by the qualified owning engine. Retain it wholly.
    native: z.unknown(),
    findings: z.array(
      z
        .object({
          file: z.string(),
          rule: z.string().nullable(),
          message: z.string(),
          severity: z.enum(['error', 'warning', 'info']),
          start: position.nullable(),
          end: position.nullable(),
        })
        .strict(),
    ),
    coverage: z.array(
      z
        .object({
          file: z.string(),
          status: z.enum([
            'analyzed',
            'typed',
            'untyped/config-mismatch',
            'parse-or-execution-failed',
            'ignored',
          ]),
          detail: z.unknown(),
        })
        .strict(),
    ),
    limitations: z.array(z.string()),
    git: z
      .object({
        head: z.string().nullable(),
        status: z.string().nullable(),
        applicability: z.enum(['observed', 'unknown']),
        diagnostic: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
