import { expect, it } from '@jest/globals';
import {
  javascriptQualityConfigSchema, typescriptQualityConfigSchema, pythonQualityConfigSchema,
} from '../../src/schemas/quality-operation-config.js';

const common = { cwd: '.', native_config: 'analysis/config.mjs', source_paths: ['src'],
  exclusions: ['src/generated'], timeout_ms: 30000, terminate_grace_ms: 2000 };
it('keeps operator-selected native code and scope explicit with one strict config per operation', () => {
  const js = { ...common, node_binary: '/opt/node/bin/node', eslint_module: 'analysis/node_modules/eslint' };
  expect(javascriptQualityConfigSchema.parse(js)).toEqual(js);
  expect(typescriptQualityConfigSchema.safeParse(js).success).toBe(false);
  const ts = { ...js, tsconfig: 'tsconfig.json', typescript_eslint_module: 'analysis/node_modules/typescript-eslint',
    typescript_module: 'analysis/node_modules/typescript' };
  expect(typescriptQualityConfigSchema.parse(ts)).toEqual(ts);
  expect(pythonQualityConfigSchema.parse({ ...common, native_config: 'ruff.toml', ruff_binary: '/opt/ruff/bin/ruff' }).ruff_binary)
    .toBe('/opt/ruff/bin/ruff');
  for (const delta of [{ source_paths: [] }, { source_paths: ['.saivage/cards'] }, { source_paths: ['../other'] },
    { source_paths: ['src/**/*.ts'] }, { source_paths: ['src', 'src'] }, { eslint_module: '/opt/eslint' },
    { node_binary: 'node' }, { timeout_ms: 0 }, { extra_args: ['--fix'] }, { output_record: 'status.md' }])
    expect(javascriptQualityConfigSchema.safeParse({ ...js, ...delta }).success).toBe(false);
});
