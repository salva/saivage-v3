import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';

export function writeSaivageConfig(root: string, value: unknown): void {
  mkdirSync(join(root, '.saivage'), { recursive: true });
  const content = typeof value === 'string' ? value : YAML.stringify(value);
  writeFileSync(join(root, '.saivage', 'saivage.yaml'), content, 'utf-8');
}

export const SAIVAGE_CONFIG_FILENAME = 'saivage.yaml';
