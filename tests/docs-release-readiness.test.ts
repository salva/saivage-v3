import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = process.cwd();

function readDoc(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), 'utf-8');
}

describe('release-readiness documentation', () => {
  it('install guide documents the current root build and CLI startup path', () => {
    const install = readDoc('docs/install.md');

    expect(install).toContain('npm run build');
    expect(install).toContain('./bin/saivage.js start');
    expect(install).not.toContain('There is no `npm run build` script in the root package');
    expect(install).not.toContain('node dist/src/server/server.js');
  });

  it('release checklist clean-checkout flow uses the current build and startup commands', () => {
    const checklist = readDoc('docs/release-checklist.md');

    expect(checklist).toContain('npm run build');
    expect(checklist).toContain('./bin/saivage.js start');
    expect(checklist).not.toContain('npx tsc');
    expect(checklist).not.toContain('node dist/src/server/server.js');
  });
});
