import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const productionFiles = [
  'src/boot/app.ts',
  'src/boot/restart-port.ts',
  'src/server/server.ts',
  'src/server/composition/server-services.ts',
];

describe('terminal cleanup call graph', () => {
  it('has one App coordinator and no nested aggregate teardown API', () => {
    const source = productionFiles.map((file) => readFileSync(join(root, file), 'utf8')).join('\n');
    for (const removed of ['disposeApplication', 'stopServerResources', 'serviceRootScope', 'server-stop']) expect(source).not.toContain(removed);
    expect(source).not.toMatch(/\.stopProject\s*\(/);
    expect(readFileSync(join(root, 'src/server/websocket.ts'), 'utf8')).not.toMatch(/onClose[\s\S]{0,160}liveSyncSocket\.dispose/);
    expect(source).toContain('onAcknowledgedRestart');
  });

  it('registers exactly the three component cleanup leaves', () => {
    const source = readFileSync(join(root, 'src/server/composition/server-services.ts'), 'utf8');
    for (const component of ['runtime', 'analyst', 'mcp']) {
      expect(source.match(new RegExp(`registerCleanupLeaf\\('${component}'`, 'g'))).toHaveLength(1);
    }
    for (const removed of ['runtime-owner', 'runtime-processes', 'analyst-processes', 'mcp-processes', 'remaining-processes']) expect(source).not.toContain(removed);
  });

  it('registers runtime admission exactly once under its owner', () => {
    const source = readFileSync(join(root, 'src/server/composition/server-services.ts'), 'utf8');
    expect(source.match(/registerAdmissionCloser\('runtime'/g)).toHaveLength(1);
    for (const removedEffect of ['tool', 'provider', 'child']) {
      expect(source).not.toContain(`registerAdmissionCloser('${removedEffect}-admission'`);
    }
  });

});
