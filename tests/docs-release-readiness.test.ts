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

  it('README records the canonical documentation authority and navigation roles', () => {
    const readme = readDoc('README.md');

    expect(readme).toContain('docs/spec/system-specification.md');
    expect(readme).toContain('docs/spec/operator-ui.md');
    expect(readme).toContain('docs/architecture/system-architecture.md');
    expect(readme).toContain('docs/runbook/index.md');
    expect(readme).toContain('README.md');
    expect(readme).toContain('deployment, startup, lifecycle, recovery, reset, and other operator procedures');
    expect(readme).toContain('Introduction, minimal quick start, authority navigation, and repository validation profiles');
    expect(readme).toContain('README-IF-YOU-ARE-AN-AI.md');
    expect(readme).toContain('Subordinate seven-stage LXC setup procedure');
    expect(readme).not.toContain('documentation tree is being reconstructed');
  });
});
