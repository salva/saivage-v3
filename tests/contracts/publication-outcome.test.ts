import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = join(process.cwd(), 'tests', 'fixtures', 'publication-fatal-port.ts');
const diagnostic = 'Fatal: PublicationOutcomeUnknownError; Saivage is halting because durable publication outcome is unknown.\n';

describe('production publication fatal port', () => {
  it('writes the exact fixed stderr bytes synchronously and exits 1', () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', fixture, 'normal'], { cwd: process.cwd(), encoding: 'utf8' });
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe(diagnostic);
  });

  it('still exits 1 without a fallback sink when fd 2 is closed', () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', fixture, 'closed-stderr'], { cwd: process.cwd(), encoding: 'utf8' });
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('');
  });

  it('keeps the production implementation free of stream and logger sinks', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'contracts', 'publication-outcome.ts'), 'utf8');
    expect(source).toContain('writeSync(2');
    expect(source).not.toMatch(/console\.|stderr\.write|appendAppLog/);
  });
});
