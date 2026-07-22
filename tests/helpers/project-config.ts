import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as YAML from 'yaml';
import { TEST_SAIVAGE_CONFIG } from './test-saivage-config.js';
import { createResolvedConfigAuthority, type ResolvedConfigAuthority } from '../../src/config/index.js';

export function writeSaivageConfig(root: string, value: unknown): void {
  mkdirSync(join(root, '.saivage'), { recursive: true });
  const content = typeof value === 'string' ? value : YAML.stringify(value);
  writeFileSync(join(root, '.saivage', 'saivage.yaml'), content, 'utf-8');
}

export const SAIVAGE_CONFIG_FILENAME = 'saivage.yaml';

export function createTestConfigAuthority(
  root: string,
  options: {
    relativePath?: string;
    config?: unknown;
    environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): ResolvedConfigAuthority {
  const path = join(root, options.relativePath ?? '.saivage/config/files-test.yaml');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(options.config ?? TEST_SAIVAGE_CONFIG), 'utf8');
  return createResolvedConfigAuthority({
    path,
    source: { kind: 'cli', argument: '--config' },
    interpolationEnvironment: options.environment ?? {},
    projectRoot:root,
  });
}
