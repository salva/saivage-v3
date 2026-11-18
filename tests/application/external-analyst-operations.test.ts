import { afterEach, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { ExternalAnalystExecutionError, ExternalAnalystOperations } from '../../src/application/external-analyst-operations.js';
import { defineTool, executedToolOutcome, OPERATIONAL_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { toolSucceeded, WorkGcBusyError } from '../../src/contracts/index.js';
import { deferred } from '../../src/runtime/actors/deferred.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { randomUUID } from 'node:crypto';
import { createObservedCollections } from '../../src/retrieval/observed-collections.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createAnalystOperationSurface, recordExternalToolCall, projectCardArtifactForOutbound } from '../../src/application/index.js';
import { createAnalystMutationServices } from '../../src/application/analyst-mutation-services.js';
import { externalToolCallSchema } from '../../src/contracts/index.js';
import { EventQueryService } from '../../src/application/event-query-service.js';
import { allowsReachedObject, BoundAgentToolSet, invokeTool, projectExternalToolResult, surfaceToolDefinitions, type InvocationSurface } from '../../src/tools/tool-api.js';
import { initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { CardService } from '../../src/cards/card-service.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { bindQualityToolExecution } from '../../src/runtime/quality-tool-execution.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import type { OperationAuthor } from '../../src/schemas/index.js';
import type { ToolContext } from '../../src/tools/execution-api.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { listControlActions } from '../../src/persistence/control-action-audit.js';
import { cardVersionArtifactSchema, cardTombstoneArtifactSchema } from '../../src/persistence/canonical-card-artifacts.js';
import { authoredRecordVersionArtifactSchema } from '../../src/persistence/canonical-record-artifacts.js';
import { cardHeadFile, cardHistoryFile, cardAcceptedRecordFile, globalAgentConversationVersionIndexFile } from '../../src/persistence/layout.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });

it('waits for accepted external tool effects and receipts without cancelling or admitting another call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'external-gc-settlement-'));
  roots.push(root);
  initProjectTree(root);
  const entered = deferred<void>();
  const release = deferred<void>();
  let held = false;
  const executor = jest.fn(async (_args: Record<string, never>, signal: AbortSignal) => {
    entered.resolve();
    await release.promise;
    expect(signal.aborted).toBe(false);
    return executedToolOutcome('none', toolSucceeded('effect settled'));
  });
  const tool = defineTool({ name: 'demo', description: 'Controlled effect.', inputSchema: z.object({}).strict(),
    resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, executor });
  const operations = new ExternalAnalystOperations({ projectRoot: root, projectIdentityDigest: 'a'.repeat(64),
    principal: 'fixture', surface: { agentName: 'analyst', tools: new Map([['demo', tool]]), providers: [] },
    processRunner: {} as never, directScope: {} as never, fatalPort: testApplicationFatalPort,
    onOwnerFailure(error) { throw error; }, assertIngressAllowed() { if (held) throw new WorkGcBusyError(); } });
  const call = operations.invoke('demo', {});
  await entered.promise;
  held = true;
  let joined = false;
  const wait = operations.awaitAcceptedOperations().then(() => {
    joined = true;
    expect(new EventQueryService(root).queryExternalToolCalls()).toHaveLength(1);
  });
  await expect(operations.invoke('demo', {})).rejects.toBeInstanceOf(WorkGcBusyError);
  expect(joined).toBe(false);
  release.resolve();
  await call;
  await wait;
  held = false;
  await operations.invoke('demo', {});
  expect(executor).toHaveBeenCalledTimes(2);
});
it('dispatches an ordinary executor rejection to the owner without recording a settled receipt', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'external-owner-failure-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const original = new Error('Private executor failure detail');
  const onOwnerFailure = jest.fn<(error: unknown) => void>();
  const executor = jest.fn(async () => { throw original; });
  const tool = defineTool({ name: 'demo', description: 'Controlled rejection.', inputSchema: z.object({}).strict(),
    resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, executor });
  const operations = new ExternalAnalystOperations({
    projectRoot, projectIdentityDigest: 'a'.repeat(64), principal: 'fixture',
    surface: { agentName: 'analyst', tools: new Map([['demo', tool]]), providers: [] },
    processRunner: {} as never, directScope: {} as never, fatalPort: testApplicationFatalPort,
    onOwnerFailure, assertIngressAllowed() {},
  });
  await expect(operations.invoke('demo', {})).rejects.toMatchObject({
    constructor: ExternalAnalystExecutionError,
    message: 'External Analyst operation failed; effects may have occurred.',
  });
  expect(executor).toHaveBeenCalledTimes(1);
  expect(onOwnerFailure).toHaveBeenCalledTimes(1);
  expect(onOwnerFailure.mock.calls[0]?.[0]).toBe(original);
  await operations.awaitAcceptedOperations();
  expect(new EventQueryService(projectRoot).queryExternalToolCalls()).toEqual([]);
});

const externalAuthor = { kind: 'external-agent', principal: 'operator-one' } as const;

function surfaceFixture(workflows: ReturnType<typeof compileProjectWorkflows>, mcpToolInvocation = unusedMcpToolInvocation) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'external-analyst-'));
  roots.push(projectRoot); initProjectTree(projectRoot, workflows);
  const store = new CardService(projectRoot,workflows);
  const registry = new ManagedProcessGroupRegistry();
  const processRunner = new ProcessRunner(projectRoot, registry, testApplicationFatalPort);
  const qualityProcessParentScope = processRunner.createContainerScope(registry.rootScope, 'analyst-fixture');
  const notifyCard = jest.fn((cardId: string, notification: Parameters<CardService['enqueueNotification']>[1]) => {
    store.enqueueNotification(cardId, notification);
    return {ok:true as const, notificationId:notification.id};
  });
  const submitNotification = jest.fn(async (_authority: import('../../src/tools/direct-object-authority.js').DirectObjectAuthority, cardId: string, notification: Parameters<typeof notifyCard>[1]) => ({
    ...notifyCard(cardId,notification), queued:true as const, cardId,
    interruption:{status:'not_requested' as const},
  }));
  const currentProcessPosition = () => null;
  const bind = (author: OperationAuthor, allowedTools: readonly string[]) => {
    const internal = author.kind === 'agent';
    const sessionId = `agent:${workflows.analyst.name}:global`;
    const ownerId = internal ? sessionId : `external:${author.principal}`;
    const context = {
      projectRoot, store, configAuthority:testConfigAuthority(projectRoot),
      retrieval:createObservedCollections(projectRoot),
      cardTypeVocabulary:workflows.cardTypeVocabulary,
      interventionReadiness:{assertInterventionReady(){}}, processRunner,
      processScope: processRunner.createDirectScope(qualityProcessParentScope, ownerId, 'operator_session'),
      qualityProcessParentScope, mcpToolInvocation,
      ...(internal ? { sessionId } : {}),
      restartCapability:{available:false as const}, eventQueries:new EventQueryService(projectRoot),
      captureExecutingLlmSnapshots:()=>new Map(),
      runtime:{notifyCard,startProject:async()=>{throw new Error('Unexpected Run.');},pause(){},resume(){},hasWorkGcMaintenanceHold:()=>false,
        stopProject:async()=>({status:'stopped' as const,contained:false}),
        getStatus:()=>({status:'stopped' as const,currentCardId:null,pid:123,startedAt:'2026-10-20T00:00:00.000Z'})},
    } satisfies Omit<ToolContext, 'actor' | 'surface' | 'policyAgentName' | 'analystMutations'>;
    const surface = createAnalystOperationSurface({
      workflows, author, allowedTools, submitNotification, currentProcessPosition, context,
      cancelCard:async()=>{throw new Error('Unexpected cancellation.');},
    });
    return { surface, context, ownerId };
  };
  return { projectRoot, store, bind, submitNotification, currentProcessPosition };
}

function fixture(allowedTools: string[], mcpToolInvocation = unusedMcpToolInvocation, omittedTools: string[] = []) {
  const config = structuredClone(TEST_SAIVAGE_CONFIG);
  config.agents.analyst!.capabilities.grants.push({ tools: ['view_image'], resources: [{ kind: 'workspace' }] });
  config.agents.analyst!.capabilities.grants = config.agents.analyst!.capabilities.grants
    .map((grant) => ({ ...grant, tools: grant.tools.filter((name) => !omittedTools.includes(name)) }))
    .filter(({ tools }) => tools.length > 0);
  const { projectRoot, store, bind, submitNotification } = surfaceFixture(compileProjectWorkflows(config), mcpToolInvocation);
  const { surface } = bind(externalAuthor, allowedTools);
  const call = (tool:string,args:unknown) => invokeTool(surface,tool,args,{
    kind:'external',principal:'operator-one',invocationId:randomUUID(),signal:new AbortController().signal,
  });
  return {projectRoot,store,surface,call,submitNotification};
}

const optionalTools = [
  'mcp_servers', 'mcp_catalog_refresh', 'mcp_server_register', 'mcp_server_set_scope',
  'mcp_server_replace', 'mcp_server_unregister',
  'code_quality_javascript_eslint', 'code_quality_typescript_eslint', 'code_quality_python_ruff',
] as const;

it.each(['default', 'reduced', 'optional'] as const)('binds the exact compiled %s selections for both authors', async (selection) => {
  const config = structuredClone(DEFAULT_SAIVAGE_CONFIG);
  const analyst = config.agents[config.analyst_agent]!;
  if (selection === 'reduced') {
    analyst.skills = false;
    analyst.capabilities.grants = [
      { tools: ['get_card'], resources: [{ kind: 'card', scopes: ['all'] }] },
      { tools: ['read'], resources: [{ kind: 'record', scopes: ['all'], patterns: ['brief.md'] }] },
      { tools: ['get_status'] },
    ];
  }
  if (selection === 'optional') {
    analyst.capabilities.grants.push({ tools: [...optionalTools] });
    const common = { cwd: '.', native_config: 'quality.config', source_paths: ['src'], exclusions: [], timeout_ms: 1_000, terminate_grace_ms: 0 };
    const eslint = { ...common, node_binary: process.execPath, eslint_module: 'node_modules/eslint/bin/eslint.js' };
    analyst.quality_tools = {
      format_version: 1,
      code_quality_javascript_eslint: eslint,
      code_quality_typescript_eslint: { ...eslint, tsconfig: 'tsconfig.json', typescript_eslint_module: 'node_modules/typescript-eslint/index.js', typescript_module: 'node_modules/typescript/lib/typescript.js' },
      code_quality_python_ruff: { ...common, ruff_binary: '/fixture/bin/ruff' },
    };
  }
  const workflows = compileProjectWorkflows(config);
  const f = surfaceFixture(workflows);
  const full = workflows.analyst.tools;
  const selectionNames = selection === 'reduced' ? ['get_card', 'read']
    : selection === 'optional' ? [...optionalTools] : full.map(({ name }) => name);
  const selected = full.filter(({ name }) => selectionNames.includes(name));
  expect(selected.map(({ name }) => name)).toEqual(selectionNames);
  expect(full.filter(({ name }) => optionalTools.some(tool => tool === name)).map(({ name }) => name))
    .toEqual(selection === 'optional' ? [...optionalTools] : []);

  const surfaces: InvocationSurface[] = [];
  for (const author of [{ kind: 'agent', agent: workflows.analyst.name }, externalAuthor] as const) {
    const { surface, context, ownerId } = f.bind(author, selectionNames);
    expect([...surface.tools.keys()]).toEqual(selectionNames);
    const analystToolContext: ToolContext = {
      ...context, policyAgentName: workflows.analyst.name,
      actor: author.kind === 'agent' ? author.agent : `external:${author.principal}`,
      surface: author.kind === 'agent' ? 'web-chat' : 'mcp',
    };
    const definitions = new BoundAgentToolSet(selected).bind({
      ...context, scope: 'global', agentName: workflows.analyst.name, processOwnerId: ownerId,
      analystToolContext,
      observationToolContext: {
        ...context, agentName: workflows.analyst.name, currentProcessPosition: f.currentProcessPosition,
        queueNotification: async () => { throw new Error('Unexpected notification in bind-only fixture.'); },
      },
      ...(workflows.analyst.qualityTools ? { quality: bindQualityToolExecution({
        projectRoot: f.projectRoot, bindings: workflows.analyst.qualityTools, operations: workflows.operations,
        processRunner: context.processRunner, parentScope: context.qualityProcessParentScope,
        ownerId: analystToolContext.actor, sessionId: analystToolContext.sessionId,
      }) } : {}),
    });
    expect(surfaceToolDefinitions(surface)).toEqual(surfaceToolDefinitions(definitions));
    surfaces.push(surface);
  }
  expect(surfaceToolDefinitions(surfaces[0]!)).toEqual(surfaceToolDefinitions(surfaces[1]!));
  for (const surface of surfaces) {
    if (selection === 'default')
      expect(surface.tools.get('read')!.description).toContain('Direct objects: workspace; records all *.');
    if (selection === 'reduced') {
      const read = surface.tools.get('read')!;
      expect(read.description).toContain('Direct objects: records all brief.md.');
      expect(read.description).not.toContain('Direct objects: workspace');
      writeFileSync(join(f.projectRoot, 'workspace.txt'), 'Ordinary synthetic workspace text.');
      const readPath = (path: string) => read.executor(read.inputSchema.parse({ path }), new AbortController().signal);
      expect(await readPath('record:///brief.md?card=project')).toMatchObject({ providerOutcome: { kind: 'succeeded' } });
      expect(await readPath('workspace.txt')).toMatchObject({
        providerOutcome: { kind: 'failed', error: expect.stringContaining('not authorized') },
      });
    }
    if (selection === 'optional') {
      for (const name of ['code_quality_javascript_eslint', 'code_quality_typescript_eslint', 'code_quality_python_ruff']) {
        const schema = surface.tools.get(name)!.inputSchema;
        expect(schema.safeParse({}).success).toBe(true);
        expect(schema.safeParse({ path: 'src' }).success).toBe(false);
      }
    }
  }
});

it('intersects the external ceiling with actual configured global tools without inventing omitted tools', async () => {
  const f = fixture(['create_card', 'get_card'], unusedMcpToolInvocation, ['create_card']);
  const create = jest.spyOn(f.store, 'create');
  expect([...f.surface.tools.keys()]).toEqual(['get_card']);
  expect(await f.call('create_card', { parent: 'project', type: 'code', title: 'Denied', bootstrap_content: 'Requirements' }))
    .toMatchObject({ kind: 'unsupported_tool' });
  expect(create).not.toHaveBeenCalled();
  expect(await f.call('get_card', { id: 'project', section: 'summary' }))
    .toMatchObject({ kind: 'executed', execution: { providerOutcome: { kind: 'succeeded' } } });
});

it('uses the real selected surface for external create/bootstrap/record/notification attribution without a transcript', async () => {
  const f=fixture(['create_card','write','read','queue_notification','delete_card']);
  const index=globalAgentConversationVersionIndexFile(f.projectRoot,'analyst');
  const before=readFileSync(index);
  expect(await f.call('create_card',{parent:'project',type:'code',title:'External child',bootstrap_content:'Actual external requirements'})).toMatchObject({kind:'executed',execution:{providerOutcome:{kind:'succeeded'}}});
  const child=f.store.read('card-a')!;
  expect(child.created_by).toBe('external:operator-one');
  const bootstrap=f.store.readRecordCurrent(child.id,'brief.md');
  if(bootstrap.kind!=='found')throw new Error('Expected bootstrap.');
  expect(bootstrap.value.projection?.accepted?.author).toEqual({kind:'external-agent',principal:'operator-one'});
  const head=JSON.parse(readFileSync(cardHeadFile(f.projectRoot,child.id),'utf8'));
  const artifact=JSON.parse(readFileSync(cardHistoryFile(f.projectRoot,child.id,head.ordinary.entry_id),'utf8'));
  expect(artifact.format_version).toBe(7);
  expect(cardVersionArtifactSchema.safeParse({...artifact,format_version:4}).success).toBe(false);
  const accepted=bootstrap.value.projection!.accepted!;
  const acceptedArtifact=JSON.parse(readFileSync(cardAcceptedRecordFile(f.projectRoot,child.id,accepted.source_entry_id),'utf8'));
  expect(acceptedArtifact.format_version).toBe(6);
  expect(authoredRecordVersionArtifactSchema.safeParse({...acceptedArtifact,format_version:4}).success).toBe(false);
  expect(await f.call('write',{path:'record:///brief.md?card=card-a',content:'Corrected external requirements'})).toMatchObject({kind:'executed',execution:{providerOutcome:{kind:'succeeded'}}});
  const corrected=f.store.readRecordCurrent(child.id,'brief.md');
  expect(corrected).toMatchObject({kind:'found',value:{projection:{accepted:{author:{kind:'external-agent',principal:'operator-one'},content:'Corrected external requirements'}}}});
  const read=await f.call('read',{path:'record:///brief.md?card=card-a'});
  expect(read).toMatchObject({kind:'executed',execution:{providerOutcome:{kind:'succeeded'}}});
  expect(await f.call('queue_notification',{card_id:'project',kind:'context',body:'External note',urgency:'normal'})).toMatchObject({kind:'executed',execution:{providerOutcome:{kind:'succeeded'}}});
   expect(f.submitNotification.mock.calls.at(-1)?.[2].source).toBe('external:operator-one');
  expect(await f.call('delete_card',{ids:[child.id]})).toMatchObject({kind:'executed',execution:{providerOutcome:{kind:'succeeded'}}});
  const deletedHead=JSON.parse(readFileSync(cardHeadFile(f.projectRoot,child.id),'utf8'));
  const tombstone=cardTombstoneArtifactSchema.parse(JSON.parse(readFileSync(cardHistoryFile(f.projectRoot,child.id,deletedHead.ordinary.entry_id),'utf8')));
  expect(tombstone.format_version).toBe(7);
  expect(tombstone.change.changed_by_actor).toBe('external:operator-one');
  expect(projectCardArtifactForOutbound(tombstone)).toMatchObject({kind:'card-tombstone',change:{actor:'external:operator-one'}});
  expect(listControlActions(f.projectRoot)).toEqual(expect.arrayContaining([expect.objectContaining({actor:'external:operator-one',surface:'mcp',outcome:'ok'})]));
  expect(readFileSync(index)).toEqual(before);
});

it('rejects guessed omitted tools and effective webfetch/write conjunctions without entering mutation or network work', async () => {
  const f=fixture(['webfetch']);
  expect([...f.surface.tools.keys()]).toEqual(['webfetch']);
  const entered=jest.spyOn(f.store,'acceptRecord');
  const fetch=jest.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network must not be reached.'));
  expect(await f.call('webfetch',{url:42})).toMatchObject({kind:'rejected_before_execution',providerOutcome:{kind:'failed',error:'Tool arguments do not match the selected tool schema.'}});
  expect(await f.call('write',{path:'record:///brief.md?card=project',content:'unauthorized'})).toMatchObject({kind:'unsupported_tool'});
  const services=createAnalystMutationServices({store:f.store,configAuthority:testConfigAuthority(f.projectRoot),
    author:{kind:'external-agent',principal:'operator-one'},authority:{anchorCardId:null,tools:f.store.workflows.analyst.tools.filter(({name})=>name==='webfetch')},
    notifyCard:()=>{throw new Error('Unexpected notification.');},submitNotification:async()=>{throw new Error('Unexpected notification.');},cancelCard:async()=>{throw new Error('Unexpected cancellation.');}});
  expect(services.recordMutations.admitWrite('record:///brief.md?card=project')).toMatchObject({ok:false,audit_outcome:'denied',result:{data:{reason:'tool_not_authorized'}}});
  expect(services.recordMutations.write('record:///brief.md?card=project','unauthorized',['write','webfetch'])).toMatchObject({success:false,data:{reason:'tool_not_authorized'}});
  const destination = 'record:///brief.md?card=project';
  const record = f.store.readRecordCurrent('project', 'brief.md');
  expect(record.kind).toBe('found');
  expect(allowsReachedObject({ anchorCardId: null, tools: f.store.workflows.analyst.tools },
    'webfetch', { kind: 'record', cardId: 'project', name: 'brief.md' })).toBe(true);
  expect(await f.call('webfetch', { url: 'http://127.0.0.1:1/fixture', save_as: destination })).toMatchObject({
    kind: 'executed', execution: { providerOutcome: {
      kind: 'failed', data: { code: 'record_mutation_denied', reason: 'tool_not_authorized' },
    } },
  });
  expect(f.store.readRecordCurrent('project', 'brief.md')).toEqual(record);
  expect(entered).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('projects real external normalized PNG bytes without publishing internal images or exposing workspace paths', async () => {
  const f=fixture(['view_image']);
  writeFileSync(join(f.projectRoot,'screen.png'),await sharp({create:{width:12,height:8,channels:3,background:'#aabbcc'}}).png().toBuffer());
  const result=await f.call('view_image',{path:'screen.png',max_dimension:6});
  if(result.kind!=='executed')throw new Error('Expected image execution.');
  const projected=projectExternalToolResult(result.execution);
  expect(projected.isError).toBe(false);
  const image=projected.content.find(block=>block.type==='image');
  if(image?.type!=='image')throw new Error('Expected external PNG.');
  expect(await sharp(Buffer.from(image.data,'base64')).metadata()).toMatchObject({format:'png',width:6,height:4});
  expect(JSON.stringify(projected)).not.toContain(f.projectRoot);
  expect(existsSync(join(f.projectRoot,'.saivage/agents/conversations/analyst/images'))).toBe(false);
  expect(projected.result).not.toHaveProperty('content');
});

it('publishes only body-free known settled receipts, with a fixed marker for untrusted tool names', async () => {
  const f=fixture(['read']);
  const requestedTool='secret arbitrary untrusted name';
  const context={kind:'external' as const,principal:'operator-one',invocationId:randomUUID(),signal:new AbortController().signal};
  const settlement=await invokeTool(f.surface,requestedTool,{secret:'not recorded'},context);
  recordExternalToolCall({...f,projectIdentityDigest:'a'.repeat(64),context,requestedTool,settlement});
  const rows=new EventQueryService(f.projectRoot).queryExternalToolCalls();
  expect(rows).toEqual([{id:context.invocationId,principal:'operator-one',project_identity_digest:'a'.repeat(64),tool:'<unsupported>',created_at:expect.any(String),execution:'rejected_before_execution',outcome:'error'}]);
  expect(externalToolCallSchema.safeParse({...rows[0],arguments:{secret:'forbidden'}}).success).toBe(false);
  const bytes=readFileSync(join(f.projectRoot,'.saivage/logs/app.jsonl'),'utf8');
  expect(JSON.parse(bytes).version).toBe(2);
  expect(bytes).not.toContain('secret');
});

it('uses configured external observed tools with ordinary receipt identity and no internal transcript mutation', async () => {
  const f=fixture(['list_observed_collections','query_observed_collections']);
  const index=globalAgentConversationVersionIndexFile(f.projectRoot,'analyst');
  const before=readFileSync(index);
  const context={kind:'external' as const,principal:'operator-one',invocationId:randomUUID(),signal:new AbortController().signal};
  const settlement=await invokeTool(f.surface,'list_observed_collections',{},context);
  expect(settlement).toMatchObject({kind:'executed',execution:{evidence:{kind:'observational_result_bytes'},providerOutcome:{kind:'succeeded',data:{collections:[],coverage:{exhaustive:false}}}}});
  recordExternalToolCall({...f,projectIdentityDigest:'a'.repeat(64),context,requestedTool:'list_observed_collections',settlement});
  expect(new EventQueryService(f.projectRoot).queryExternalToolCalls()).toEqual([expect.objectContaining({id:context.invocationId,tool:'list_observed_collections',outcome:'ok'})]);
  const log=readFileSync(join(f.projectRoot,'.saivage/logs/app.jsonl'),'utf8');
  expect(log).not.toContain('exhaustive');expect(readFileSync(index)).toEqual(before);
  expect(await f.call('query_observed_collections',{collections:['not-configured'],query:'private-query-not-for-receipts'})).toMatchObject({kind:'executed',execution:{providerOutcome:{kind:'failed'}}});
  expect(await f.call('read',{path:'README.md'})).not.toMatchObject({kind:'executed'});
});

it('preserves ordered native MCP text/PNG output externally without forged LLM telemetry or publication', async () => {
  const bytes=await sharp({create:{width:4,height:2,channels:3,background:'#00ff00'}}).png().toBuffer();
  const invoke=jest.fn<typeof unusedMcpToolInvocation.invokeTool>().mockResolvedValue({content:[
    {type:'text',text:'before'}, {type:'image',mimeType:'image/png',data:bytes.toString('base64')},
    {type:'text',text:'after'},
  ]});
  const f=fixture(['mcp_tool_call'],{...unusedMcpToolInvocation,invokeTool:invoke});
  const settlement=await f.call('mcp_tool_call',{serverName:'synthetic',bindingId:randomUUID(),catalogId:randomUUID(),toolName:'screen'});
  if(settlement.kind!=='executed')throw new Error('Expected native execution.');
  const projected=projectExternalToolResult(settlement.execution);
  expect(projected.isError).toBe(false);
  expect(projected.content.map(block=>block.type)).toEqual(['text','image','text']);
  expect(invoke.mock.calls[0]?.[5]?.observationSource).toBeUndefined();
  expect(existsSync(join(f.projectRoot,'.saivage/agents/conversations/analyst/images'))).toBe(false);
});
