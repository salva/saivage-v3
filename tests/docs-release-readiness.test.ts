import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = process.cwd();

function readDoc(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), 'utf-8');
}

describe('release-readiness documentation', () => {
  it('README documents the current release validation commands', () => {
    const readme = readDoc('README.md');

    expect(readme).toContain('npm run validate:routine');
    expect(readme).toContain('npm run validate:release');
    expect(readme).toContain('npm run build');
    expect(readme).toContain('npm test');
  });

  it('README records the current reconstructed documentation tree', () => {
    const readme = readDoc('README.md');

    expect(readme).toContain('docs/spec/');
    expect(readme).toContain('docs/architecture/');
    expect(readme).toContain('documentation tree is being reconstructed');
  });
});
