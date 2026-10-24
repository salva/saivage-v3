import { z } from 'zod';

// Pure operator input contracts, shared by compiled actions and optional tool bindings.
// Paths other than executables are relative to the project root, not process cwd.
const relativePath = z.string().min(1).max(4096).refine((value) =>
  !value.startsWith('/') && !/[\0\r\n\\*?\[\]{}]/u.test(value) &&
  !value.split('/').some((part) => part === '' || part === '.' || part === '..') &&
  !value.split('/').some((part) => part === '.saivage' || part === '.saivage-work' || part === '.git'),
  'Expected an exact project-relative path outside private/runtime roots.',
);
const executable = z.string().min(2).max(4096).refine((value) =>
  value.startsWith('/') && !/[\0\r\n]/u.test(value) &&
  !value.slice(1).split('/').some((part) => part === '' || part === '.' || part === '..'),
  'Expected an explicit absolute executable provisioning path.',
);
const paths = z.array(relativePath).max(256).refine(
  (values) => new Set(values).size === values.length, 'Duplicate scope path.',
);
const common = {
  cwd: z.union([z.literal('.'), relativePath]),
  native_config: relativePath,
  source_paths: paths.refine((values) => values.length > 0, 'Source scope cannot be empty.'),
  exclusions: paths,
  timeout_ms: z.number().int().min(1).max(600000),
  terminate_grace_ms: z.number().int().min(0).max(10000),
};
const eslint = { ...common, node_binary: executable, eslint_module: relativePath };

export const javascriptQualityConfigSchema = z.object(eslint).strict();
export const typescriptQualityConfigSchema = z.object({
  ...eslint,
  tsconfig: relativePath,
  typescript_eslint_module: relativePath,
  typescript_module: relativePath,
}).strict();
export const pythonQualityConfigSchema = z.object({ ...common, ruff_binary: executable }).strict();

export const qualityToolNames = [
  'code_quality_javascript_eslint', 'code_quality_typescript_eslint', 'code_quality_python_ruff',
] as const;
export type QualityToolName = typeof qualityToolNames[number];
export const qualityToolBindingsSchema = z.object({
  format_version: z.literal(1),
  code_quality_javascript_eslint: javascriptQualityConfigSchema.optional(),
  code_quality_typescript_eslint: typescriptQualityConfigSchema.optional(),
  code_quality_python_ruff: pythonQualityConfigSchema.optional(),
}).strict().refine((value) => qualityToolNames.some((name) => value[name] !== undefined),
  'quality_tools must bind at least one quality tool.');
export type QualityToolBindings = z.infer<typeof qualityToolBindingsSchema>;
