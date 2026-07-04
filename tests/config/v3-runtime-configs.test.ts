import { describe, expect, it } from '@jest/globals';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '../../src/config/environment.js';

const workspaceRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const v3RuntimeTargets = [
  { name: 'saivage-e2e-checkers', root: resolve(workspaceRoot, 'saivage-e2e-checkers') },
  { name: 'getrich-v2', root: resolve(workspaceRoot, 'getrich-v2') },
  { name: 'pueblicos', root: resolve(workspaceRoot, 'pueblicos') },
];

describe('v3 runtime target configs', () => {
  it.each(v3RuntimeTargets)('$name loads through loadEnvironment when present', ({ root }) => {
    const configPath = resolve(root, '.saivage/saivage.json');
    if (!existsSync(configPath)) return;

    expect(() => {
      loadEnvironment(['node', 'test', '--project-root', root], process.env);
    }).not.toThrow();
  });
});
