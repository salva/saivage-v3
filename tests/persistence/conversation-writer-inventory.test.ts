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
      .filter((path) => /import[\s\S]*?appendConversationMessage[\s\S]*?from/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(process.cwd(), path));

    expect(importers).toEqual(['src/persistence/conversation-mutation-port.ts']);
  });
});
