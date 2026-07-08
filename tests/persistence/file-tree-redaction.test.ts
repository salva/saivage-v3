import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readProjectFileAtomic } from '../../src/persistence/file-tree.js';

const roots: string[] = [];
function root(): string { const r = mkdtempSync(join(tmpdir(), 'saivage-file-tree-redaction-')); roots.push(r); mkdirSync(join(r, '.saivage'), { recursive: true }); return r; }
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('project config file-tree redaction and obsolete blocking', () => {
  it('redacts canonical YAML and blocks obsolete JSON', () => {
    const r = root();
    writeFileSync(join(r, '.saivage', 'saivage.yaml'), 'telegram:\n  botToken: secret-token\n', 'utf-8');
    writeFileSync(join(r, '.saivage', 'saivage.json'), '{"telegram":{"botToken":"secret-token"}}', 'utf-8');

    const yaml = readProjectFileAtomic(r, '.saivage/saivage.yaml', { redactSecrets: true });
    expect(yaml).toContain('[REDACTED]');
    expect(yaml).not.toContain('secret-token');
    expect(() => readProjectFileAtomic(r, '.saivage/saivage.json', { redactSecrets: true })).toThrow(/blocked for security/);
    expect(() => readProjectFileAtomic(r, '.saivage/saivage.json')).toThrow(/blocked for security/);
  });
});
