import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function runtimeSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return runtimeSources(path);
    return entry.endsWith('.ts') ? [path] : [];
  });
}

describe('runtime/server import boundary', () => {
  it('keeps runtime package files free of server-layer imports', () => {
    const runtimeDir = join(process.cwd(), 'src', 'runtime');
    const offenders = runtimeSources(runtimeDir).filter((file) => /from ['"]\.\.\/server\//.test(readFileSync(file, 'utf-8')));
    expect(offenders).toEqual([]);
  });
});
