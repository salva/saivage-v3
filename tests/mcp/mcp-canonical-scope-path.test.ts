import { expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
let forbidden: string[] = [];
let checking = false;
jest.unstable_mockModule('node:fs', () => ({
  ...fs,
  readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    if (checking && forbidden.some(path => String(args[0]).startsWith(path))) throw new Error('Forbidden sibling/orphan/descendant read');
    return fs.readFileSync(...args);
  },
  readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
    if (checking) throw new Error('Scope admission must not enumerate');
    return fs.readdirSync(...args);
  },
}));
const { CardService, initProjectTree } = await import('../helpers/canonical-project.js');
const { cardNamespace, cardHeadFile } = await import('../../src/persistence/layout.js');
const { McpManager, MCP_OPERATOR_CALLER, MCP_OPERATIONS } = await import('../../src/mcp/manager-api.js');
const { ProcessRunner, ManagedProcessGroupRegistry } = await import('../../src/runtime/runtime-api.js');
const { testApplicationFatalPort } = await import('../helpers/test-application-fatal-port.js');
const { createTestConfigAuthority } = await import('../helpers/project-config.js');

it('uses only committed exact paths despite reordered siblings, poisoned unlinked prefixes and a tombstoned ancestor', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'mcp-canonical-path-'));
  initProjectTree(root);
  const cards = new CardService(root);
  const create = (parent: string, type: 'goal' | 'code') => cards.create({ parent, type, title: 'Exact path', bootstrap_content: 'Canonical scope fixture.', created_by: 'analyst', depends_on: [] }).id;
  const a = create('project', 'goal'), b = create('project', 'goal'), child = create(a, 'code');
  const orphan = `${a}-z`;
  fs.mkdirSync(cardNamespace(root, orphan), { recursive: true });
  fs.writeFileSync(cardHeadFile(root, orphan), 'poisoned unlinked canonical-looking head');
  const groups = new ManagedProcessGroupRegistry();
  const runner = new ProcessRunner(root, groups, testApplicationFatalPort);
  const manager = new McpManager({ nativeGit: false, readCanonicalLivePath: id => cards.readCanonicalLivePath(id),
    processRunner: runner, configAuthority: createTestConfigAuthority(root), mcpProcessRootScope: groups.createContainerScope(groups.rootScope, 'mcp'), eventLogger: { appendEventPrepared() {} } as never });
  const caller = { principal: { kind: 'card' as const, cardId: a }, operations: MCP_OPERATIONS };
  try {
    forbidden = [cardNamespace(root, b), cardNamespace(root, orphan)]; checking = true;
    manager.registerServer(caller, 'one', { transport: 'stdio', command: process.execPath }, { controllerCardId: child, exposure: 'subtree' });
    expect(manager.getServerStatus(caller, 'one')).toMatchObject({ policy: { controllerCardId: child } });
    expect(() => manager.registerServer(caller, 'fake', { transport: 'stdio', command: process.execPath }, { controllerCardId: orphan, exposure: 'subtree' })).toThrow('unavailable');
    checking = false; cards.reorderChildren('project', [b, a]); checking = true;
    expect(manager.getServerStatus(caller, 'one')).toMatchObject({ policy: { controllerCardId: child } });
    const selectedHead = fs.readFileSync(cardHeadFile(root, child));
    fs.writeFileSync(cardHeadFile(root, child), 'complete malformed selected head\n');
    try {
      expect(() => manager.getServerStatus(caller, 'one')).toThrow();
      try { manager.getServerStatus(caller, 'one'); } catch (error) {
        expect((error as Error).message).not.toContain('MCP server unavailable');
      }
    } finally { fs.writeFileSync(cardHeadFile(root, child), selectedHead); }
    checking = false; cards.deleteSubtrees([a], () => true, 'analyst');
    forbidden.push(cardNamespace(root, child)); checking = true;
    expect(manager.getServerStatus(MCP_OPERATOR_CALLER, 'one')).toMatchObject({ ready: false, policy: { controllerCardId: child } });
    expect(() => manager.getServerCatalog(MCP_OPERATOR_CALLER, 'one')).toThrow('unavailable');
    manager.setServerScope(MCP_OPERATOR_CALLER, 'one', { controllerCardId: 'project', exposure: 'subtree' });
  } finally { checking = false; forbidden = []; await manager.cleanupForApplicationStop(); fs.rmSync(root, { recursive: true, force: true }); }
});
