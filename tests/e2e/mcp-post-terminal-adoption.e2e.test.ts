import { expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../helpers/canonical-project.js';
import { MCP_OPERATOR_CALLER } from '../../src/mcp/access-policy.js';
import type { App } from '../../src/boot/app.js';
import {
  createServer, listen, closeServer, readJsonRequest, sendToolCall, sendFinalMessage,
  offeredToolNames, productionTestConfig, writeProductionConfig, initializeProject,
  startProductionApp, appOrigin, postStartProject, waitFor, type ChatCompletionRequest,
} from '../helpers/production-composition-e2e.js';

it('adopts only after actual compiled child terminal settlement releases its parent; Stop preserves the same session, app restart does not launch it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-terminal-adoption-'));
  const token = 'scoped-mcp-fixture';
  let app: App | undefined;
  let cards!: CardService;
  let child = '', later = '';
  let parentStep = 0, childStep = 0, analystStep = 0;
  let failure: unknown;
  let selection!: { bindingId: string; catalogId: string; processId: string | null };
  const peer = String.raw`let n=0;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const r=JSON.parse(line);if(r.id===undefined)return;
    const result=r.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'serial',version:'1'}}:
      r.method==='tools/list'?{tools:[{name:'count',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:String(++n)}]};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n');});`;
  const connection = { transport: 'stdio', command: process.execPath, args: ['-e', peer] };
  const provider = createServer(async (req, res) => {
    try {
      const body = await readJsonRequest(req) as ChatCompletionRequest;
      const tools = offeredToolNames(body);
      const previous = body.messages.at(-1);
      const result = previous?.role === 'tool' ? JSON.parse(previous.content) : null;
      const emit = (name: string, args: object) => sendToolCall(res, `${name}-${parentStep}-${childStep}-${analystStep}`, name, args);
      if (tools.includes('start_project')) {
        if (analystStep++ === 0) emit('start_project', {});
        else sendFinalMessage(res);
      } else if (tools.includes('activate_card')) {
        switch (++parentStep) {
          case 1: emit('activate_card', { card_id: child, instructions: 'Register and exercise the scoped peer, then return done.' }); break;
          case 2: {
            // This provider continuation is created only by the real Supervisor
            // after child terminal publication/owner settlement, not an outside edit.
            expect(cards.read(child)?.lifecycle.status).toBe('done');
            expect(result.success).toBe(true);
            const status = app!.server.mcpManager.getServerStatus(MCP_OPERATOR_CALLER, 'serial')!;
            expect(status).toMatchObject({ ready: true, policy: { controllerCardId: child } });
            const catalog = app!.server.mcpManager.getServerCatalog(MCP_OPERATOR_CALLER, 'serial')!;
            selection = { bindingId: catalog.bindingId, catalogId: catalog.catalogId, processId: status.processId };
            emit('mcp_server_set_scope', { serverName: 'serial', policy: { controllerCardId: 'project', exposure: 'subtree' } });
            break;
          }
          case 3:
            expect(result).toMatchObject({ success: true, data: { updated: true } });
            emit('mcp_tools', { serverName: 'serial' }); break;
          case 4:
            expect(result.data).toMatchObject({ bindingId: selection.bindingId, catalogId: selection.catalogId });
            expect(app!.server.mcpManager.getServerStatus(MCP_OPERATOR_CALLER, 'serial')!.processId).toBe(selection.processId);
            emit('mcp_tool_call', { serverName: 'serial', bindingId: selection.bindingId, catalogId: selection.catalogId, toolName: 'count' }); break;
          case 5:
            expect(JSON.stringify(result)).toContain('"text":"2"');
            emit('activate_card', { card_id: later, instructions: 'Use the adopted peer without restarting it, then return done.' }); break;
          case 6:
            expect(cards.read(later)?.lifecycle.status).toBe('done');
            emit('emit_result', { outcome: 'blocked', summary: 'Fixture execution complete; explicit Stop is tested separately.' }); break;
          default: throw new Error('Unexpected parent turn');
        }
      } else {
        switch (++childStep) {
          case 1: emit('mcp_server_register', { serverName: 'serial', connection }); break;
          case 2: expect(result.success).toBe(true); emit('mcp_server_control', { serverName: 'serial', action: 'start' }); break;
          case 3: expect(result.success).toBe(true); emit('mcp_tools', { serverName: 'serial' }); break;
          case 4: emit('mcp_tool_call', { serverName: 'serial', bindingId: result.data.bindingId, catalogId: result.data.catalogId, toolName: 'count' }); break;
          case 5: expect(JSON.stringify(result)).toContain('"text":"1"'); emit('emit_result', { outcome: 'done', summary: 'Peer is application-lived, not disposed by this return.' }); break;
          case 6: emit('mcp_tools', { serverName: 'serial' }); break;
          case 7:
            expect(result.data).toMatchObject({ bindingId: selection.bindingId, catalogId: selection.catalogId });
            emit('mcp_tool_call', { serverName: 'serial', bindingId: selection.bindingId, catalogId: selection.catalogId, toolName: 'count' }); break;
          case 8: expect(JSON.stringify(result)).toContain('"text":"3"'); emit('emit_result', { outcome: 'done', summary: 'Same session verified.' }); break;
          default: throw new Error('Unexpected child turn');
        }
      }
    } catch (error) { failure = error; res.statusCode = 500; res.end(); }
  });
  try {
    const port = await listen(provider);
    writeProductionConfig(root, productionTestConfig(port, config => {
      config.agents.planner!.capabilities.grants.push({ tools: ['mcp_server_set_scope', 'mcp_tools', 'mcp_tool_call'] });
      config.agents.executor!.capabilities.grants.push({ tools: ['mcp_server_register'] });
      // Keep real compiled workflows, owners and tool binding; drop irrelevant
      // record acceptance gates from this purpose-named lifecycle fixture.
      for (const name of ['project', 'code']) for (const node of Object.values(config.card_types[name]!.workflow.nodes)) {
        node.records = {}; node.initialize_records = [];
        for (const edge of Object.values(node.edges)) {
          if ('target' in edge && edge.target && 'terminal' in edge.target) edge.target.export_records = [];
        }
      }
    }));
    initializeProject(root);
    cards = new CardService(root);
    const create = () => cards.create({ parent: 'project', type: 'code', title: 'Serial MCP participant', bootstrap_content: 'Exercise the scoped peer and return.', created_by: 'analyst', depends_on: [] }).id;
    child = create(); later = create();
    app = await startProductionApp(root, token);
    expect((await postStartProject(appOrigin(app), token)).status).toBe(200);
    await waitFor(() => !!failure || parentStep === 6, 'serial terminal adoption');
    if (failure) throw failure;
    await waitFor(() => cards.read('project')?.lifecycle.status === 'blocked', 'parent terminal settlement');
    await app.server.runtimeApplication.runtimeApi.stopProject();
    expect(app.server.mcpManager.getServerStatus(MCP_OPERATOR_CALLER, 'serial')).toMatchObject({ ready: true, bindingId: selection.bindingId, processId: selection.processId });
    await app.stop(); app = undefined;
    app = await startProductionApp(root, token);
    expect(app.server.mcpManager.getServerStatus(MCP_OPERATOR_CALLER, 'serial')).toMatchObject({ status: 'stopped', ready: false, containment: 'not_started', processId: null, policy: { controllerCardId: 'project', exposure: 'subtree' } });
    expect(app.server.mcpManager.getServerCatalog(MCP_OPERATOR_CALLER, 'serial')).toBeUndefined();
  } finally { await app?.stop(); await closeServer(provider); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
