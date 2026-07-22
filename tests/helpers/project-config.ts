import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as YAML from 'yaml';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
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
  writeFileSync(path, YAML.stringify(options.config ?? {
    models: { default: ['test-model'], max_tokens: { analyst: 200 } },
    providers: { test: { models: ['test-model'] } },
    compaction: {
      enabled: true,
      input_budget_tokens: 1000,
      summarizer_candidate: { provider: 'test', account: null, model: 'test-model' },
    },
    card_processes: DEFAULT_CARD_PROCESSES,
  }), 'utf8');
  return createResolvedConfigAuthority({
    path,
    source: { kind: 'cli', argument: '--config' },
    interpolationEnvironment: options.environment ?? {},
  });
}
