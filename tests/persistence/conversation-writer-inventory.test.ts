import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from '@jest/globals';

const sourceRoot = join(process.cwd(), 'src');

function typescriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? typescriptFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('production conversation writer inventory', () => {
  it('confines raw conversation append imports to the mutation-port implementation', () => {
    const importers = typescriptFiles(sourceRoot)
      .filter((path) => /import\s*{[^}]*\bappendConversationMessage\b[^}]*}\s*from/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(process.cwd(), path));

    expect(importers).toEqual(['src/persistence/conversation-mutation-port.ts']);
  });

  it('confines raw active-version replacement imports to the mutation-port implementation', () => {
    const importers = typescriptFiles(sourceRoot)
      .filter((path) => /import\s*{[^}]*\bwriteCompactedConversationVersion\b[^}]*}\s*from/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(process.cwd(), path));

    expect(importers).toEqual(['src/persistence/conversation-mutation-port.ts']);
  });
});

describe('provider-exchange writer inventory', () => {
  it('confines raw provider-exchange append imports to the mutation port and persistence-focused tests', () => {
    const importers = [sourceRoot, join(process.cwd(), 'tests')]
      .flatMap(typescriptFiles)
      .filter((path) => /import\s*{[^}]*\bappendProviderExchangeLogEntry\b[^}]*}\s*from/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(process.cwd(), path))
      .sort();

    expect(importers).toEqual([
      'src/persistence/provider-exchange-mutation-port.ts',
      'tests/application/read-models.test.ts',
      'tests/server/operator-agent-llm-exchange.test.ts',
    ]);
  });
});
