import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

const OBSERVED_DEFINITIONS = '.saivage/config/observed-collections.json';
export const OBSERVED_DEPLOYMENT = '.saivage/config/observed-collections-native.json';
export const XERJ_KEY = '.saivage/config/xerj.key';
export const XERJ_SOURCE = '922921aec0d69b551ea714c40fca601eb331a759';
export const XERJ_BINARY_SHA256 =
  'e6872c55ddd910d2edbccdc3956cd5c4beceffce0899abe15bfad7f3fdd642e1';
export const XERJ_MODEL_REVISION = '1110a243fdf4706b3f48f1d95db1a4f5529b4d41';
export const XERJ_MODEL_FILES = {
  'config.json': '953f9c0d463486b10a6871cc2fd59f223b2c70184f49815e7efbcab5d8908b41',
  'tokenizer.json': 'be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037',
  'model.safetensors': '53aa51172d142c89d9012cce15ae4d6cc0ca6895895114379cacb4fab128d9db',
} as const;

const bytes = (max: number) =>
  z
    .string()
    .min(1)
    .refine((s) => Buffer.byteLength(s) <= max);
// Deliberately small slash grammar: punctuation with glob/regex meaning is not literal syntax.
const component = /^[\p{L}\p{N}_. @+,-]+$/u;
const directorySchema = bytes(512).refine(
  (s) =>
    s === '.' ||
    (!isAbsolute(s) &&
      s.split('/').every((part) => part !== '.' && part !== '..' && component.test(part))),
);
const patternSchema = bytes(512).refine(
  (s) =>
    !isAbsolute(s) &&
    s.split('/').every((part) => {
      if (part === '**') return true;
      return (
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !part.includes('**') &&
        component.test(part.replaceAll('*', 'a'))
      );
    }),
);
const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const observedCollectionsSchema = z
  .object({
    format_version: z.literal(1),
    type: z.literal('observed-collections'),
    collections: z
      .array(
        z
          .object({
            name: nameSchema,
            purpose: bytes(1024),
            kind: z.enum(['documentation', 'code']),
            directory: directorySchema,
            include: z.array(patternSchema).min(1).max(64),
            exclude: z.array(patternSchema).max(64),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .refine((v) => new Set(v.collections.map((c) => c.name)).size === v.collections.length);
export type ObservedCollections = z.infer<typeof observedCollectionsSchema>;

const hasControlCharacter = (value: string) =>
  [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const absolutePath = z
  .string()
  .min(1)
  .refine((s) => isAbsolute(s) && !hasControlCharacter(s));
const endpointSchema = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return (
      u.protocol === 'http:' &&
      u.hostname === '127.0.0.1' &&
      u.port !== '' &&
      !u.username &&
      !u.password &&
      u.pathname === '/' &&
      !u.search &&
      !u.hash &&
      s === `http://127.0.0.1:${u.port}`
    );
  } catch {
    return false;
  }
});
export const observedDeploymentSchema = z
  .object({
    format_version: z.literal(1),
    type: z.literal('xerj-observed-deployment'),
    endpoint: endpointSchema,
    native: z
      .object({
        source: z.literal(XERJ_SOURCE),
        executable: absolutePath,
        sha256: z.literal(XERJ_BINARY_SHA256),
      })
      .strict(),
    model: z
      .object({
        revision: z.literal(XERJ_MODEL_REVISION),
        directory: absolutePath,
        mode: z.literal('neural'),
        dimensions: z.literal(384),
        files: z
          .object({
            'config.json': z.literal(XERJ_MODEL_FILES['config.json']),
            'tokenizer.json': z.literal(XERJ_MODEL_FILES['tokenizer.json']),
            'model.safetensors': z.literal(XERJ_MODEL_FILES['model.safetensors']),
          })
          .strict(),
      })
      .strict(),
    roots: z
      .array(
        z
          .object({ directory: directorySchema, prefix: z.string().regex(/^sv-[a-f0-9]{32}$/) })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.roots.map((r) => r.directory)).size === v.roots.length &&
      new Set(v.roots.map((r) => r.prefix)).size === v.roots.length,
  );
export type ObservedDeployment = z.infer<typeof observedDeploymentSchema>;

export function readObservedCollections(projectRoot: string): ObservedCollections | null {
  let source: string;
  try {
    source = readFileSync(join(projectRoot, OBSERVED_DEFINITIONS), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Cannot read observed collection definitions.');
  }
  try {
    return observedCollectionsSchema.parse(JSON.parse(source));
  } catch {
    throw new Error('Invalid observed collection definitions.');
  }
}

export function readObservedDeployment(projectRoot: string): ObservedDeployment {
  try {
    return observedDeploymentSchema.parse(
      JSON.parse(readFileSync(join(projectRoot, OBSERVED_DEPLOYMENT), 'utf8')),
    );
  } catch {
    throw new Error('Invalid or missing observed collection deployment.');
  }
}

export function readXerjKey(projectRoot: string): string {
  try {
    const encoded = readFileSync(join(projectRoot, XERJ_KEY));
    const raw = encoded.toString('utf8');
    if (!Buffer.from(raw).equals(encoded)) throw new Error();
    const key = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (Buffer.byteLength(raw) > 4096 || !key || /\s/u.test(key) || hasControlCharacter(key))
      throw new Error();
    return key;
  } catch {
    throw new Error('Invalid or missing observed collection credential.');
  }
}
