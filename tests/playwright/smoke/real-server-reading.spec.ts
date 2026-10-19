import { agentExecution, directEdge } from '../../helpers/workflow-execution.js';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { App } from '../../../src/boot/app.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../../src/config/system-templates/registry.js';
import { createResolvedConfigAuthority } from '../../../src/config/index.js';
import { CardService } from '../../../src/cards/card-service.js';
import { appendConversationBatch, readConversationCatalog, readConversation } from '../../../src/persistence/conversation-file.js';
import { publishConversationImage } from '../../../src/persistence/session-api.js';
import { projectNativeMcpResult } from '../../../src/tools/mcp-native-result.js';
import { settleToolActionOutcome } from '../../../src/tools/tool-result-settlement.js';
import { agentMessageSchema, cardParentId, canonicalJson, sha256Hex, STRUCTURAL_ROW_POLICY, type ConversationSessionId } from '../../../src/schemas/index.js';
import { ToolResultSchema } from '../../../src/contracts/tool-result.js';
import { ViewImageDataSchema } from '../../../src/contracts/view-image.js';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { createPromptTemplateRegistry } from '../../../src/utils/prompt-api.js';
import { appendActivationMarker, buildGlobalAgentIngressRows, buildUserContextMessage } from '../../../src/runtime/actors/conversation-session.js';
import { buildModelRepairMessage, buildSettledToolResult } from '../../../src/runtime/actors/llm-delivery-log.js';
import { describeNodeResultContract } from '../../../src/runtime/runtime-api.js';
import { formatVocabularySnippet } from '../../../src/tools/prompt-api.js';
import { redactTextForOutbound } from '../../../src/redaction/index.js';
import { OPERATIONAL_RESULT_POLICY_TEMPLATE, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE } from '../../../src/tools/invocation.js';
import { productionTestConfig, writeProductionConfig, initializeProject, startProductionApp, appOrigin, listen, closeServer } from '../../helpers/production-composition-e2e.js';
import { publishThreeGenerationCompactedConversation } from '../../helpers/compacted-conversation-fixture.js';
import { toolRowPolicies, TEXT_ROW_POLICY } from '../../helpers/row-policy-fixtures.js';
import { seedTokenBeforeNavigation } from '../smoke/fixtures/operator-preview-sync.js';
import { currentConversationSegmentPath } from '../../helpers/current-conversation-segment-path.js';
import { cardHeadFile } from '../../../src/persistence/layout.js';
import { bootstrapContextSupplier } from '../../../src/runtime/records/bootstrap-context.js';
import { workspaceToolBinders } from '../../../src/tools/workspace-provider.js';
import { readWorkspaceInputSchema } from '../../../src/contracts/index.js';
import { WORKSPACE_ARGUMENT_CANARY, WORKSPACE_ARGUMENT_PATH, WORKSPACE_ARGUMENT_PUBLIC_PATH } from '../../helpers/workspace-argument-egress-fixture.js';

// Reuse the existing smoke harness's asset build/preview bootstrap. Every page
// navigation below targets the independently owned startApp origin, not preview.
test.describe.configure({ timeout: 120_000, retries: 0 });

const token = 'synthetic-reader-only-token';
const analyst = 'agent:analyst:global' as const;
const planner = 'agent:planner:project' as const;
const inputId = '00000000-0000-4000-8000-000000000088';
const timestamp = '2026-10-07T12:00:00.000Z';
// Follow-up outputs never replace the delivered reader's original evidence.
const evidence = fileURLToPath(new URL('../../../docs/working/2026-10-11-conversation-delivered-prompts-fix/evidence/real-server/', import.meta.url));
const retainedCommand = `npm test -- ${'long_unbroken_argument_'.repeat(160)} final-command-Z`;
const longText = Array.from({ length: 40 }, (_, n) => `Retained line ${n}: ${'ordinary readable evidence '.repeat(8)}`).join('\n');
let root: string;
let app: App;
let origin: string;
let executor: ConversationSessionId;
let workflows: ReturnType<ReturnType<typeof createResolvedConfigAuthority>['loadEffective']>['workflows'];
let imageDescriptor: ReturnType<typeof publishConversationImage>;
const providerRequests: string[] = [];
const unchangedSelections = new Map<string, Buffer>();
const sink = createServer((request, response) => {
  providerRequests.push(`${request.method} ${request.url}`);
  response.writeHead(400); response.end('inert provider: calls forbidden');
});

async function orderedContent(reader: Locator) {
  const exchange = reader.locator(`[data-tool-entry-id="${inputId}:tool-call:ordered-content"]`);
  await expect(exchange).toHaveCount(1);
  await expect(exchange).toContainText('Observation recorded · Effects opaque');
  const toggle = exchange.locator('.tool-chip-toggle');
  await toggle.click();
  const result = exchange.locator('.tool-result');
  const sections = result.locator(':scope > .semantic-section');
  await expect(sections).toHaveCount(8);
  await expect(sections.nth(0)).toContainText('MCP envelope metadata');
  await expect(sections.nth(1)).toContainText('MCP native block metadata');
  await expect(sections.nth(2)).toContainText('MCP image capture metadata');
  await expect(sections.nth(3)).toContainText('Returned text · content 1');
  await expect(sections.nth(3)).toContainText('ordered-before-Z');
  await expect(sections.nth(4)).toContainText('Typed image descriptor · content 2');
  await expect(sections.nth(5)).toContainText('Returned text · content 3');
  await expect(sections.nth(5)).toContainText('plain-text-Z');
  await expect(sections.nth(6)).toContainText('Typed image descriptor · content 4');
  await expect(sections.nth(7)).toContainText('Returned text · content 5');
  await expect(sections.nth(7)).toContainText('ordered-after-Z');
  expect((await sections.allTextContents()).join('|')).toMatch(/ordered-before-Z.*content 2.*plain-text-Z.*content 4.*ordered-after-Z/s);
  await expect(exchange.locator(`[data-entry-id="${inputId}:tool-call:ordered-content"]`)).toHaveCount(1);
  await expect(exchange.locator(`[data-entry-id="${inputId}:tool-result:ordered-content"]`)).toHaveCount(1);
  await expect(result.locator('a, img, canvas')).toHaveCount(0);
  await expect(result.locator('.safe-original code')).toContainText('ordered-after-Z');
  await toggle.click();
}

async function seed(session: ConversationSessionId) {
  let index = 0;
  const row = (id: string, content: string, role: 'assistant' | 'user' | 'system' | 'tool' = 'assistant') => ({
    id, session_id: session, role, kind: 'text', content, context_policy: TEXT_ROW_POLICY,
    round_id: `r-${role === 'system' ? 'pre' : role === 'tool' ? 'assistant' : role}-${inputId.replaceAll('-', '')}`,
    message_index: index++, block_index: 0, timestamp,
  });
  const pair = (name: string, tool: string, args: object, result: object) => {
    const content = JSON.stringify(ToolResultSchema.parse(result));
    const policy = toolRowPolicies({ content,
      template: tool === 'view_image' ? OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE : OPERATIONAL_RESULT_POLICY_TEMPLATE,
      ...(tool === 'view_image' ? { evidence: { kind: 'observational_query' as const, observedSha256: createHash('sha256').update(content, 'utf8').digest('hex') } } : {}),
    });
    return [
      { ...row(`${inputId}:tool-call:${name}`, JSON.stringify({ role: 'assistant', tool_calls: [{ id: name, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] })), kind: 'tool_call', tool, tool_call_id: name, context_policy: policy.call },
      { ...row(`${inputId}:tool-result:${name}`, content, 'tool'), kind: 'tool_result', tool, tool_call_id: name, context_policy: policy.result },
    ];
  };
  // Valid selected raster; the browser must never request it or the original path.
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 1 } } }).png().toBuffer();
  const image = publishConversationImage(root, session, png, { width: 1, height: 1 });
  // Actual native MCP producer and ordinary settlement; this is not an official browser E2E.
  const nativeResult = settleToolActionOutcome(await projectNativeMcpResult({ content: [
    { type: 'text', text: 'ordered-before-Z' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
    { type: 'text', text: '{"synthetic":"plain-text-Z"}' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
    { type: 'text', text: 'ordered-after-Z' },
  ] }, root, session, new AbortController().signal)).providerResult;
  if (session === executor) imageDescriptor = image;
  const command = pair('command', 'run_command', { command: retainedCommand, cwd: '.', wait: true }, {
    success: true, data: { process_id: 'proc-012345abcdef', status: 'exited', exit_code: 0,
      stdout: `${longText}\nfinal-stdout-Z`, stderr: 'final-stderr-Q', stdout_complete: true, stderr_complete: true,
      stdout_bytes: Buffer.byteLength(`${longText}\nfinal-stdout-Z`), stderr_bytes: 14 },
  });
  const rows = [
    { ...row(`${inputId}:activation`, JSON.stringify({ event: 'activation_open', agent_name: session.split(':')[1],
      ...(session === analyst ? {} : { card_id: session.split(':')[2] }), input_id: inputId, timestamp, instructions: { kind: 'unavailable', reason: 'not_recorded' } }), 'system'), kind: 'activity', context_policy: STRUCTURAL_ROW_POLICY.activation_boundary },
    row('recorded-system', `${longText}\nfinal-system-Z`, 'system'),
    command[0], row('between', 'No result was known at this intervening prose.'), command[1], row('correction', 'Correction after result.'),
    ...pair('failed-command', 'run_command', { command: 'synthetic-failure' }, { success: false, error: 'Synthetic command failed: final-failure-Z' }),
    ...pair('failed-location', 'read', readWorkspaceInputSchema.parse({ path: WORKSPACE_ARGUMENT_PATH, metadata_only: true }), { success: false, error: 'Synthetic rejected location FINAL-RESULT-Z' }),
    ...pair('image', 'view_image', { path: 'synthetic-screen.png', max_dimension: 1600 }, { success: true, content: [{ type: 'image', image }],
      data: ViewImageDataSchema.parse({ source_path: 'synthetic-screen.png', source_dimensions: { width: 1, height: 1 }, oriented_dimensions: { width: 1, height: 1 }, sent_dimensions: { width: 1, height: 1 }, orientation_applied: false, resized: false, scale: { x: 1, y: 1 }, max_dimension: 1600 }) }),
    ...pair('ordered-content', 'mcp_tool_call', { serverName: 'synthetic', toolName: 'capture' }, nativeResult),
    row('tail', `${longText}\nfinal-transcript-Z`),
  ];
  appendConversationBatch({ projectRoot: root }, rows.map(r => agentMessageSchema.parse(r)));
}

// Real compiled prompt rendering, production marker/context/repair builders and
// canonical publication. No provider call or installed project is involved.
function seedInstructionEvidence(session: ConversationSessionId, cardType: 'code' | 'project') {
  const registry = createPromptTemplateRegistry(workflows);
  const process = workflows.cardTypes.get(cardType)!;
  const names = session === analyst ? ['global'] : cardType === 'project' ? ['plan'] : ['execute', 'verify'];
  const markers: string[] = [];
  const promptRows: string[] = [];
  for (const [ordinal, name] of names.entries()) {
    const sourceId = `11111111-1111-4111-8111-${String(ordinal + 1).padStart(12, '0')}`;
    if (session === analyst) {
      const role = registry.render({ kind: 'global-agent' }, 'analyst', { vocabularySnippet: formatVocabularySnippet(workflows.cardTypeVocabulary) });
      const ingress = buildGlobalAgentIngressRows(session, sourceId, 'Synthetic operator question', { kind: 'prepared', activation_id:null,caller:{kind:'global'},card:null,parent_direction:null,role_text: role, node: null });
      appendConversationBatch({ projectRoot: root }, ingress);
      markers.push(ingress[0].id);
      continue;
    }
    const node = process.states.get(`node:${name}`)!;
    if (node.kind !== 'node') throw new Error('Expected fixture compiled node.');
    const role = registry.render({ kind: 'workflow-agent', cardType }, agentExecution(node).agent.name, { contractDescription: describeNodeResultContract(process, `node:${name}`) });
    const compiledPrompt = process.processPrompts.get(agentExecution(node).prompt.promptId)!;
    const nodeText = `Current workflow node '${name}':\n\n${compiledPrompt.text}`;
    const cardId = session.split(':')[2]!;
    const parentId = cardParentId(cardId);
    const marker = appendActivationMarker({ projectRoot: root }, session, {
      event: 'activation_open', agent_name: agentExecution(node).agent.name, card_id: session.split(':')[2]!, input_id: sourceId,
      instructions: { kind: 'prepared',activation_id:sourceId,caller:parentId===null?{kind:'root'}:{kind:'parent',cardId:parentId,sessionId:`agent:planner:${parentId}` as ConversationSessionId,sourceInputId:sourceId,toolCallId:`synthetic-parent-${ordinal}`,toolName:'activate_card'},card:{cardId,cardType,title:'Synthetic card'},parent_direction:parentId===null?null:{text:'Synthetic parent direction for this explicitly authored reading fixture.'}, role_text: role, node: { node_id: name, text: nodeText } },
    });
    markers.push(marker.id);
    const entryRoute = process.states.get('entry:BACKLOG')!.on.values().next().value!;
    const prior = process.states.get('node:execute');
    const edge = prior && [...prior.on.values()].find(edge => edge.targetStateId === `node:${name}`);
    const transition = ordinal === 0 ? entryRoute : edge;
    if (!transition || !('prompt' in transition.semantic) || !transition.semantic.prompt)
      throw new Error('Fixture requires an actual configured lifecycle/edge prompt.');
    const declaration = transition.semantic.prompt;
    const prompt = { role: 'user' as const, content: process.processPrompts.get(declaration.promptId)!.text, instruction_origin: 'workflow_prompt' as const,
      protection: { compactable: declaration.compactable, ...(declaration.compactionKey === undefined ? {} : { compaction_key: declaration.compactionKey }) } };
    const owned = buildUserContextMessage(session, sourceId, 'process_transition', 0, prompt);
    const neighbor = buildUserContextMessage(session, sourceId, 'process_transition', 1, { role: 'user', content: prompt.content });
    appendConversationBatch({ projectRoot: root }, [owned, neighbor]);
    promptRows.push(owned.id);
    if (agentExecution(node).correctionPrompt) {
      const correction = process.processPrompts.get(agentExecution(node).correctionPrompt.promptId)!;
      const directive = { ...prompt, content: correction.text, protection: { compactable: agentExecution(node).correctionPrompt.compactable, ...(agentExecution(node).correctionPrompt.compactionKey === undefined ? {} : { compaction_key: agentExecution(node).correctionPrompt.compactionKey }) } };
      const repair = buildModelRepairMessage({ sessionId: session, inputId: sourceId } as Parameters<typeof buildModelRepairMessage>[0], directive);
      const continuation = buildUserContextMessage(session, sourceId, 'continuation_hook', 0, directive);
      appendConversationBatch({ projectRoot: root }, [repair, continuation]);
      promptRows.push(repair.id, continuation.id);
    }
  }
  if (session === analyst) appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows(session,
    '99999999-9999-4999-8999-999999999999', 'Synthetic confirmation-only ingress', { kind: 'not_applicable', reason: 'non_model_ingress' }));
  return { markers, promptRows };
}
const instructionFixtures = new Map<ConversationSessionId, ReturnType<typeof seedInstructionEvidence>>();
let recordEvidence: { session: ConversationSessionId; rows: string[]; parent: string };
let protectedRecordId: string;
const quotedRecordBody = 'Notes\napi_key: body-egress-canary\nSafe "quote" \\ path {{recordSelection}} {{> never-expand}}\nFINAL-BODY-Z';

async function seedRecordEvidence() {
  const store = new CardService(root, workflows);
  const card = store.create({ type: 'code', parent: 'project', title: 'Record observation fixture', bootstrap_content: 'Accepted A', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
  const session = `agent:executor:${card.id}` as ConversationSessionId;
  const workflow = workflows.cardTypes.get('code')!;
  const node = workflow.states.get('node:execute')!;
  if (node.kind !== 'node') throw new Error('Expected execute node.');
  const parent = 'Inspect these accepted requirements; token=parent-egress-canary\nFINAL-PARENT-DIRECTION-Z';
  const registry = createPromptTemplateRegistry(workflows);
  appendActivationMarker({ projectRoot: root }, session, { event: 'activation_open', agent_name: 'executor', card_id: card.id, input_id: inputId,
    instructions: { kind: 'prepared', activation_id: inputId, caller: { kind: 'parent', cardId: 'project', sessionId: planner, sourceInputId: inputId, toolCallId: 'activate-record-fixture', toolName: 'activate_card' }, card: { cardId: card.id, cardType: 'code', title: card.title }, parent_direction: { text: parent }, role_text: registry.render({ kind: 'workflow-agent', cardType: 'code' }, 'executor', { contractDescription: describeNodeResultContract(workflow, 'node:execute') }), node: { node_id: node.nodeId, text: workflow.processPrompts.get(agentExecution(node).prompt.promptId)!.text } } });
  const supplier = bootstrapContextSupplier(store, card, node);
  store.acceptRecord(card.id, 'status.md', quotedRecordBody, { kind: 'agent', agent: 'analyst' });
  const initial = supplier({ inputId, conversation: readConversation(root, session) });
  appendConversationBatch({ projectRoot: root }, initial.rows);
  store.acceptRecord(card.id, 'brief.md', 'Accepted B token=record-egress-canary FINAL-RECORD-B-Z', { kind: 'agent', agent: 'analyst' });
  const tool = workspaceToolBinders.find(tool => tool.name === 'read')!.bind({ projectRoot: root, store, agentName: 'executor', cardId: card.id });
  const args = { path: `record:///brief.md?card=${card.id}`, metadata_only: true };
  const execution = await tool.executor(args, new AbortController().signal);
  const template = OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE;
  const templateBytes = canonicalJson(template);
  const call = agentMessageSchema.parse({ id: `${inputId}:tool-call:record-metadata`, session_id: session, role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: 'record-metadata', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'record-metadata', type: 'function', function: { name: 'read', arguments: JSON.stringify(args) } }] }), context_policy: { kind: 'tool_call', template, template_bytes: templateBytes, template_sha256: sha256Hex(templateBytes) }, round_id: `r-assistant-${inputId.replaceAll('-', '')}`, message_index: 0, block_index: 0, timestamp });
  const result = buildSettledToolResult({ session_id: session, source_input_id: inputId, tool_call_id: 'record-metadata', tool_name: 'read', resultPolicy: { resultPolicyTemplate: template, resultPolicyTemplateBytes: templateBytes, resultPolicyTemplateSha256: sha256Hex(templateBytes) }, settlement: { kind: 'executed', execution } }).message;
  appendConversationBatch({ projectRoot: root }, [call, result]);
  const knownB = supplier({ inputId, conversation: readConversation(root, session) });
  expect(knownB.rows.every(row => row.kind !== 'record_prompt')).toBe(true);
  appendConversationBatch({ projectRoot: root }, knownB.rows);
  store.acceptRecord(card.id, 'brief.md', 'Accepted C', { kind: 'agent', agent: 'analyst' });
  const changed = supplier({ inputId, conversation: readConversation(root, session) });
  appendConversationBatch({ projectRoot: root }, changed.rows);
  recordEvidence = { session, rows: [...initial.rows, call, result, ...knownB.rows, ...changed.rows].map(row => row.id), parent: redactTextForOutbound(parent) };
}

test('production timeline preserves conditional chronology, parent safe copy and descriptor-only record evidence', async ({ page }) => {
  await seedTokenBeforeNavigation(page, token);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.goto(`${origin}/agents/${recordEvidence.session}?segment=1`);
  const response = await page.request.get(`${origin}/api/agents/${encodeURIComponent(recordEvidence.session)}/conversation/versions/1`, { headers: { authorization: `Bearer ${token}` } });
  const dto = parseOperatorResponse('agents.conversationVersions.get', 200, await response.json());
  const current = parseOperatorResponse('agents.conversation', 200, await (await page.request.get(`${origin}/api/agents/${encodeURIComponent(recordEvidence.session)}/conversation`, { headers: { authorization: `Bearer ${token}` } })).json());
  expect(JSON.stringify(current)).not.toContain('body-egress-canary');
  expect(JSON.stringify(current)).toContain('FINAL-BODY-Z');
  expect(JSON.stringify(dto)).not.toMatch(/egress-canary|content_sha256|template_sha256|result_content_sha256/);
  const timeline = page.locator('.conversation-container .conversation-timeline');
  const parent = timeline.locator('.instruction-disclosure').filter({ has: page.locator('summary', { hasText: 'Parent activation direction' }) });
  await parent.locator('summary').click();
  await expect(parent.locator('pre')).toHaveText(recordEvidence.parent);
  await parent.getByRole('button', { name: 'copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(recordEvidence.parent);
  const actual = dto.entries.filter(row => recordEvidence.rows.includes(row.id));
  expect(actual.map(row => row.id)).toEqual(recordEvidence.rows);
  const readExchange = timeline.locator(`[data-tool-entry-id="${inputId}:tool-call:record-metadata"]`);
  await expect(readExchange).toHaveCount(1);
  await readExchange.locator('.tool-chip-toggle').click();
  expect(await timeline.locator('[data-entry-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-entry-id')))).toEqual([dto.entries[0]!.id, ...recordEvidence.rows]);
  for (const row of actual.filter(row => row.kind === 'record_prompt')) {
    const instruction = timeline.locator(`[data-entry-id="${row.id}"] .instruction-disclosure`);
    await instruction.locator('summary').click();
    await expect(instruction.locator('pre')).toHaveText(row.content);
    await instruction.getByRole('button', { name: 'copy', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(row.content);
    if (row.content.includes('FINAL-BODY-Z')) {
      expect(row.content).toContain('{{recordSelection}} {{> never-expand}}');
      expect(row.content).toContain('\\napi_key: [REDACTED]\\n');
      expect(await instruction.textContent()).not.toContain('body-egress-canary');
    }
  }
  const observationGroups = await timeline.getByTestId('record-observations').all();
  const expectedGroups = actual.filter(row => row.record_observations);
  expect(observationGroups).toHaveLength(expectedGroups.length);
  for (const [index, observation] of observationGroups.entries()) {
    await observation.locator(':scope > summary').click();
    await expect(observation).toContainText('not delivery, body recall');
    for (const item of expectedGroups[index]!.record_observations!) {
      await expect(observation).toContainText(`Source: ${item.source.kind}`);
      await expect(observation).toContainText(`Selection: ${item.observed.selection.kind} · Exposure: ${item.observed.exposure.kind}`);
    }
  }
  await expect(timeline).toContainText('Descriptor only: no historical full prepared record text was recorded.');
  await expect(timeline.getByRole('button', { name: /Inspect immutable record evidence/ }).first()).toBeVisible();
  expect(await timeline.textContent()).not.toContain('Accepted B token=record-egress-canary');
  expect(providerRequests).toEqual([]);
  const recordEvidenceDirectory = fileURLToPath(new URL('../../../docs/working/2026-10-13-explicit-activation-context/evidence/browser/', import.meta.url));
  mkdirSync(recordEvidenceDirectory, { recursive: true });
  await page.screenshot({ path: join(recordEvidenceDirectory, 'record-context-timeline.png'), fullPage: true });
});

test('production API historical prepared/workflow evidence stays source-local, safely copyable and independent of current config', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedTokenBeforeNavigation(page, token);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const reader = page.locator('.conversation-container');
  for (const session of [executor, analyst]) {
    const fixture = instructionFixtures.get(session)!;
    await page.goto(`${origin}/agents/${session}?segment=1&entry=${encodeURIComponent(fixture.markers[0]!)}`);
    const response = await page.request.get(`${origin}/api/agents/${encodeURIComponent(session)}/conversation/versions/1`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status()).toBe(200);
    const dto = parseOperatorResponse('agents.conversationVersions.get', 200, await response.json());
    expect(JSON.stringify(dto)).not.toMatch(/canary|UNACTIVATED DISK CONTENT|CURRENT-LOADED-ONLY-Z|producer_account_id|provider_projection/);
    const timeline = reader.locator('.conversation-timeline');
    await expect(timeline).toContainText('Historical instructions unavailable — not recorded');
    if (session === analyst) await expect(timeline).toContainText('No model invocation for this ingress');
    expect(await timeline.locator('.activation-marker').evaluateAll(es => es.filter(e => e.textContent?.includes('Prepared instructions')).map(e => e.getAttribute('data-entry-id')))).toEqual(fixture.markers);
    for (const markerId of fixture.markers) {
      const marker = timeline.locator(`[data-entry-id="${markerId}"]`);
      await expect(marker).toContainText('not proof of model delivery or interpretation');
      const instructions = JSON.parse(dto.entries.find(entry => entry.id === markerId)!.content).instructions;
      const role = marker.locator('.instruction-disclosure').first();
      await role.locator('summary').click();
      await expect(role.locator('pre')).toHaveText(instructions.role_text);
      await role.getByRole('button', { name: 'copy', exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(instructions.role_text);
      expect(instructions.role_text).not.toContain('{{contractDescription}}');
      if (instructions.node) {
        const node = marker.locator('.instruction-disclosure').filter({ has: page.locator('summary', { hasText: `Node ${instructions.node.node_id} instructions` }) });
        await expect(node.locator('summary')).toHaveText(`Node ${instructions.node.node_id} instructions`);
        await node.locator('summary').click();
        await expect(node.locator('pre')).toHaveText(instructions.node.text);
        await node.getByRole('button', { name: 'copy', exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(instructions.node.text);
      }
    }
    const marked = dto.entries.filter(entry => entry.instruction_origin === 'workflow_prompt');
    expect(marked.map(entry => entry.id)).toEqual(fixture.promptRows);
    for (const entry of marked) {
      const row = timeline.locator(`[data-entry-id="${entry.id}"]`);
      await expect(row).toContainText('Recorded workflow instruction');
      await expect(row).toContainText('delivery not established');
      expect(await row.locator('pre').count()).toBe(1);
      await expect(row.locator('pre')).toHaveText(entry.content);
      await row.locator(':scope > details > summary').click();
      await expect(row.locator('pre')).toBeVisible();
      await row.getByRole('button', { name: 'copy', exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(entry.content);
    }
    if (session === executor) {
      const unmarkedNeighbor = dto.entries.find(entry => entry.kind === 'text' && !entry.instruction_origin && entry.content === marked[0]!.content)!;
      await expect(timeline.locator(`[data-entry-id="${unmarkedNeighbor.id}"]`)).not.toContainText('Recorded workflow instruction');
      // A real exact cursor tail contains independently classified prompts but no
      // invented activation start or current-config substitution.
      const current = parseOperatorResponse('agents.conversation', 200, await (await page.request.get(`${origin}/api/agents/${encodeURIComponent(session)}/conversation`, { headers: { authorization: `Bearer ${token}` } })).json());
      const tail = parseOperatorResponse('agents.conversation', 200, await (await page.request.get(`${origin}/api/agents/${encodeURIComponent(session)}/conversation?segment_id=${current.segment_id}&segment_version=${current.segment_version}&since=${encodeURIComponent(fixture.markers.at(-1)!)}`, { headers: { authorization: `Bearer ${token}` } })).json());
      expect(tail.entries.some(entry => entry.instruction_origin === 'workflow_prompt')).toBe(true);
      expect(tail.entries.some(entry => entry.kind === 'activity')).toBe(false);
      // The visible tail is the real API's exact cursor response, not authored
      // UI strings. Only the source-fixture transport selects that response.
      const tailUrl = `${origin}/api/agents/${encodeURIComponent(session)}/conversation`;
      await page.route(tailUrl, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(tail) }));
      await page.goto(`${origin}/agents/${session}`);
      await page.reload();
      await expect(timeline).toContainText('The activation start is outside this displayed segment or tail');
      await expect(timeline.locator('.activation-marker')).toHaveCount(0);
      await expect(timeline.locator('.instruction-disclosure').first()).toContainText('Recorded workflow instruction');
      await page.unroute(tailUrl);
    }
    await expect(reader.locator('.current-instructions')).not.toHaveAttribute('open', '');
    await reader.locator('.current-instructions > summary').click();
    await expect(reader.locator('.current-instructions')).toContainText('CURRENT-LOADED-ONLY-Z');
    await reader.locator('.current-instructions > summary').click();
    await expect(reader.locator('.technical-details')).toHaveCount(1);
    expect(await timeline.textContent()).not.toContain('Delivered instructions');
  }
  await page.goto(`${origin}/agents/${planner}`);
  await expect(reader).toContainText('Earlier activation instructions are in indexed source history');
  const context = reader.getByTestId('conversation-segment-context');
  await context.locator(':scope > summary').click();
  const protectedContext = context.getByTestId('retained-instruction-context');
  await protectedContext.locator(':scope > summary').click();
  const retainedWorkflow = protectedContext.locator('li').filter({ hasText: 'final-protected-Z' });
  await retainedWorkflow.locator(':scope > details > summary').click();
  await expect(protectedContext).toContainText('Recorded workflow instruction');
  await expect(protectedContext).toContainText('final-protected-Z');
  await retainedWorkflow.locator('.instruction-disclosure > summary').click();
  const protectedText = await retainedWorkflow.locator('.instruction-disclosure pre').textContent();
  await retainedWorkflow.getByRole('button', { name: 'copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(protectedText);
  await reader.getByRole('button', { name: 'Inspect source segment 2', exact: true }).click();
  await expect(reader).toContainText('Conversation · exact segment 2');
  await reader.getByRole('button', { name: 'Inspect source segment 1', exact: true }).click();
  await expect(reader.locator(`[data-entry-id="${instructionFixtures.get(planner)!.markers[0]}"]`)).toContainText('Prepared instructions');
  await expect(reader.getByTestId('conversation-segment-context')).toHaveCount(0);
  expect(providerRequests).toEqual([]);
  await page.close();
});

test('compacted supplier record prompt keeps safe retained disclosure and full clipboard bytes', async ({ page }) => {
  await seedTokenBeforeNavigation(page, token);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const response = await page.request.get(`${origin}/api/agents/${encodeURIComponent(planner)}/conversation`, { headers: { authorization: `Bearer ${token}` } });
  const dto = parseOperatorResponse('agents.conversation', 200, await response.json());
  expect(JSON.stringify(dto)).not.toContain('body-egress-canary');
  const retained = dto.segment_context!.protected_prompts.find(entry => entry.message.id === protectedRecordId)!;
  expect(retained.message.content).toContain('FINAL-BODY-Z');
  expect(retained.message.content).toContain('\\napi_key: [REDACTED]\\n');
  expect(retained.message.instruction_origin).toBe('workflow_prompt');
  expect(retained.message.record_observations![0]!.observed.selection).toMatchObject({ kind: 'accepted', locator: expect.stringContaining('record:///status.md?card=project&v=') });
  const history = parseOperatorResponse('agents.conversationVersions.get', 200, await (await page.request.get(`${origin}/api/agents/${encodeURIComponent(planner)}/conversation/versions/${retained.source.segment_version}`, { headers: { authorization: `Bearer ${token}` } })).json());
  expect(history.entries.find(entry => entry.id === protectedRecordId)).toEqual(retained.message);
  await page.goto(`${origin}/agents/${planner}`);
  const context = page.getByTestId('conversation-segment-context');
  await context.locator(':scope > summary').click();
  const protectedContext = context.getByTestId('retained-instruction-context');
  await protectedContext.locator(':scope > summary').click();
  const record = protectedContext.locator('li').filter({ hasText: 'FINAL-BODY-Z' });
  await record.locator(':scope > details > summary').click();
  await record.locator('.instruction-disclosure > summary').click();
  await expect(record.locator('.instruction-disclosure pre')).toHaveText(retained.message.content);
  await record.getByRole('button', { name: 'copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(retained.message.content);
  expect(await record.textContent()).not.toContain('body-egress-canary');
  expect(providerRequests).toEqual([]);
});

test('rejected workspace request has public location bytes in Request, safe-original and full copy for current and history', async ({ page }) => {
  await seedTokenBeforeNavigation(page, token);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  for (const session of [executor, analyst]) {
    for (const historical of [false, true]) {
      const base = `${origin}/api/agents/${encodeURIComponent(session)}/conversation`;
      const response = await page.request.get(historical ? `${base}/versions/1` : base, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status()).toBe(200);
      const responseJson = await response.json();
      const { dto, expectedOrientation } = (() => {
        if (historical) {
          const historicalDto = parseOperatorResponse('agents.conversationVersions.get', 200, responseJson);
          return { dto: historicalDto, expectedOrientation: 'Conversation · exact segment 1' };
        }
        const currentDto = parseOperatorResponse('agents.conversation', 200, responseJson);
        return { dto: currentDto, expectedOrientation: `Conversation · current segment ${currentDto.segment_version}` };
      })();
      expect(JSON.stringify(dto)).not.toContain(WORKSPACE_ARGUMENT_CANARY);
      const id = `${inputId}:tool-call:failed-location`;
      const publicCall = dto.entries.find(row => row.id === id)!;
      const argumentsValue = JSON.parse(JSON.parse(publicCall.content).tool_calls[0].function.arguments);
      expect(argumentsValue).toEqual({ path: WORKSPACE_ARGUMENT_PUBLIC_PATH, metadata_only: true });
      expect(dto.entries.find(row => row.id === `${inputId}:tool-result:failed-location`)?.content).toContain('FINAL-RESULT-Z');
      await page.goto(`${origin}/agents/${session}${historical ? '?segment=1' : ''}`);
      const inspector = session === analyst ? page.locator('.global-session-reader') : page.getByTestId('facet-conversations');
      const reader = inspector.locator('.conversation-container');
      await expect(reader).toHaveCount(1);
      await expect(reader).toBeVisible();
      await expect(reader.locator('.segment-context > strong')).toHaveText(expectedOrientation);
      // Source entry IDs are not page-global projection IDs.
      const exchange = reader.locator(`[data-tool-entry-id="${id}"]`);
      await expect(exchange).toHaveCount(1);
      await expect(exchange).toBeVisible();
      if (session === executor) {
        const dockExchange = page.getByTestId('chat-scroll-container').locator(`[data-tool-entry-id="${id}"]`);
        await expect(dockExchange).toHaveCount(1);
        await expect(dockExchange).toBeVisible();
      }
      await exchange.locator('.tool-chip-toggle').click();
      const request = exchange.locator('.tool-request');
      await expect(request).toContainText('Request');
      await expect(request).toContainText(WORKSPACE_ARGUMENT_PUBLIC_PATH);
      expect(await request.textContent()).not.toContain(WORKSPACE_ARGUMENT_CANARY);
      const safe = request.locator('.safe-original');
      await safe.locator('summary').click();
      await expect(safe.locator('pre')).toHaveText(publicCall.content);
      await safe.getByRole('button', { name: 'copy', exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(publicCall.content);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(JSON.parse(JSON.parse(copied).tool_calls[0].function.arguments)).toEqual(argumentsValue);
      expect(copied).toContain('FINAL-PATH-Z');
      expect(copied).not.toContain(WORKSPACE_ARGUMENT_CANARY);
    }
  }
  expect(providerRequests).toEqual([]);
});

test.beforeAll(async () => {
  const port = await listen(sink);
  root = mkdtempSync(join(tmpdir(), 'reading-real-server-'));
  const config = productionTestConfig(port, config => {
    for (const [name, agent] of Object.entries(config.agents)) agent.tools = [...DEFAULT_SAIVAGE_CONFIG.agents[name]!.tools];
    config.providers.fixture!.capabilities = { ...config.providers.fixture!.capabilities, transportProtocol: 'openai-responses', imageInput: true };
    config.oversight.enabled = false;
    config.mcpServers = {};
    config.card_types.code!.workflow.entries.BACKLOG.prompt = { reference: 'stopped-recovery', compactable: true };
    config.card_types.project!.workflow.entries.BACKLOG.prompt = { reference: 'stopped-recovery', compactable: true };
    const nodes = config.card_types.code!.workflow.nodes;
    nodes.verify = structuredClone(nodes.execute!);
    directEdge(nodes.execute!.edges.done!).target = { node: 'verify' };
    directEdge(nodes.execute!.edges.done!).prompt = { reference: 'plan-to-review', compactable: true };
  });
  writeProductionConfig(root, config);
  // Preserve actual bundled image guidance and compose an explicit fragment seam.
  const promptRoot = join(root, '.saivage/config/prompts');
  mkdirSync(join(promptRoot, 'agents/_shared'), { recursive: true });
  mkdirSync(join(promptRoot, 'fragments/_shared'), { recursive: true });
  mkdirSync(join(promptRoot, 'process/_shared'), { recursive: true });
  writeFileSync(join(promptRoot, 'process/_shared/execute.md'), `${readFileSync(join(process.cwd(), 'src/config/system-templates/classic/prompts/process/_shared/execute.md'), 'utf8')}\nSynthetic node source sentinel token=node-egress-canary\nfinal-recorded-node-Z`);
  writeFileSync(join(promptRoot, 'fragments/_shared/reader-canary.md'), 'api_key=fragment-canary\nsk-');
  for (const name of ['executor', 'analyst']) {
    const bundled = readFileSync(join(process.cwd(), `src/config/system-templates/classic/prompts/agents/_shared/${name}.md`), 'utf8');
    writeFileSync(join(promptRoot, `agents/_shared/${name}.md`), `${bundled}\n{{> reader-canary}}seam-canary\n${longText}\nfinal-loaded-instructions-Z`);
  }
  initializeProject(root);
  workflows = createResolvedConfigAuthority({ path: join(root, '.saivage/saivage.yaml'), projectRoot: root, interpolationEnvironment: {} }).loadEffective().workflows;
  const child = new CardService(root, workflows).create({ type: 'code', parent: 'project', title: 'Synthetic reader child', bootstrap_content: 'Synthetic brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
  executor = `agent:executor:${child.id}` as ConversationSessionId;
  await seedRecordEvidence();
  await seed(executor); await seed(analyst);
  for (const [session, cardType] of [[executor, 'code'], [analyst, 'code'], [planner, 'project']] as const)
    instructionFixtures.set(session, seedInstructionEvidence(session, cardType));
  const store = new CardService(root, workflows);
  store.acceptRecord('project', 'status.md', quotedRecordBody, { kind: 'agent', agent: 'analyst' });
  const node = workflows.cardTypes.get('project')!.states.get('node:plan')!;
  if (node.kind !== 'node') throw new Error('Expected plan node.');
  const protectedNode = { ...node, recordPrompts: node.recordPrompts.map(input => ({ ...input, prompt: { ...input.prompt, compactable: false } })) };
  const prepared = bootstrapContextSupplier(store, store.read('project')!, protectedNode)({ inputId, conversation: readConversation(root, planner) });
  protectedRecordId = prepared.rows.find(row => row.kind === 'record_prompt' && row.content.includes('FINAL-BODY-Z'))!.id;
  appendConversationBatch({ projectRoot: root }, prepared.rows);
  await publishThreeGenerationCompactedConversation(root, `${longText}\nfinal-summary-Z`, {
    first: { content: `${longText}\nfirst-protected-Z`, key: 'reader-protected', instruction_origin: 'workflow_prompt' },
    replacement: { content: `${longText}\nfinal-protected-Z`, key: 'reader-protected', instruction_origin: 'workflow_prompt' },
  });
  for (const path of [cardHeadFile(root, 'project'), cardHeadFile(root, child.id), ...[executor, analyst, planner, recordEvidence.session].map(session => currentConversationSegmentPath(root, session))]) unchangedSelections.set(path, readFileSync(path));
  // Capture precedes a genuinely different loaded template observation. The
  // historical API must keep its old strings while current configuration changes.
  for (const name of ['executor', 'analyst']) {
    const path = join(promptRoot, `agents/_shared/${name}.md`);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nCURRENT-LOADED-ONLY-Z\nfinal-loaded-instructions-Z`);
  }
  workflows = createResolvedConfigAuthority({ path: join(root, '.saivage/saivage.yaml'), projectRoot: root, interpolationEnvironment: {} }).loadEffective().workflows;
  app = await startProductionApp(root, token);
  origin = appOrigin(app);
  // An unactivated edit is not loaded configuration; expectedBindings retains
  // the exact compilation used at startup, as do the real server's actors.
  writeFileSync(join(promptRoot, 'agents/_shared/executor.md'), 'UNACTIVATED DISK CONTENT\n{{contractDescription}}');
  expect(providerRequests).toEqual([]);
});

test.afterAll(async () => {
  try {
    if (app) await app.stop();
    for (const [path, bytes] of unchangedSelections) expect(readFileSync(path)).toEqual(bytes);
  }
  finally {
    await closeServer(sink);
    if (root) rmSync(root, { recursive: true, force: true });
    expect(providerRequests).toEqual([]);
  }
});

function expectedBindings(session: ConversationSessionId) {
  const registry = createPromptTemplateRegistry(workflows);
  if (session === analyst) return [{ kind: 'global', instructions: redactTextForOutbound(registry.render(
    { kind: 'global-agent' }, 'analyst', { vocabularySnippet: formatVocabularySnippet(workflows.cardTypeVocabulary) })) }];
  const cardType = session === planner ? 'project' : 'code';
  const workflow = workflows.cardTypes.get(cardType)!;
  return [...workflow.states].flatMap(([id, state]) => state.kind === 'node' && agentExecution(state).agent.name === session.split(':')[1]
    ? [{ kind: 'workflow_node', node_id: state.nodeId, instructions: redactTextForOutbound(registry.render(
      { kind: 'workflow-agent', cardType }, agentExecution(state).agent.name, { contractDescription: describeNodeResultContract(workflow, id) })) }] : []);
}

async function instructions(page: Page, reader: Locator, session: ConversationSessionId, historical: boolean) {
  const disclosure = reader.locator('.current-instructions');
  await expect(disclosure).not.toHaveAttribute('open');
  const url = `/api/agents/${encodeURIComponent(session)}/current-instructions`;
  const wait = () => page.waitForResponse(r => new URL(r.url()).pathname === url && r.request().method() === 'GET');
  const opened = wait();
  await disclosure.locator('summary').click();
  const response = await opened;
  expect(response.status()).toBe(200);
  const dto = parseOperatorResponse('agents.currentInstructions', 200, await response.json());
  expect(dto.bindings).toEqual(expectedBindings(session));
  expect(JSON.stringify(dto)).not.toContain('canary');
  if (historical) await expect(disclosure).toContainText('not the instructions recorded for this historical segment');
  const blocks = disclosure.locator('section .code-block');
  await expect(blocks).toHaveCount(dto.bindings.length);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  for (let i = 0; i < dto.bindings.length; i++) {
    await expect(blocks.nth(i).locator('pre')).toHaveText(dto.bindings[i]!.instructions);
    await blocks.nth(i).getByRole('button', { name: 'copy', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(dto.bindings[i]!.instructions);
  }
  const refreshed = wait(); await disclosure.getByRole('button', { name: 'Refresh', exact: true }).click();
  expect(parseOperatorResponse('agents.currentInstructions', 200, await (await refreshed).json())).toEqual(dto);
  return dto;
}

async function capture(page: Page, reader: Locator, name: string, expectOverflow = false) {
  const geometry = await reader.evaluate(container => {
    const painted = [container, ...container.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const owners = painted.filter(e => e.matches('.conversation-reading-surface, .chat-scroll-area'));
    const owner = owners[0];
    // The Analyst composer is a sibling, not conversation content. Within the
    // actual reading owner reject nested CSS scrollports even when they fit.
    const content = painted.filter(e => e === owner || owner?.contains(e));
    const metrics = (e: Element) => ({ classes: e.className, height: e.clientHeight, extent: e.scrollHeight,
      overflowY: getComputedStyle(e).overflowY, isOwner: e === owner });
    return { owners: owners.map(metrics),
      nestedScrollOwners: content.filter(e => e !== owner && /auto|scroll/.test(getComputedStyle(e).overflowY)).map(metrics),
      scrollports: content.filter(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1).map(metrics),
      pageWidth: document.documentElement.clientWidth, pageExtent: document.documentElement.scrollWidth,
      anchors: painted.filter(e => e.hasAttribute('data-entry-id')).map(e => ({ id: e.getAttribute('data-entry-id'), y: e.getBoundingClientRect().y })) };
  });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, `${name}.geometry.json`), JSON.stringify({ ...geometry, expectOverflow }, null, 2));
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' });
  expect(geometry.owners, `${name}: exactly one identified reading owner`).toHaveLength(1);
  expect(geometry.owners[0]!.overflowY, `${name}: owner CSS`).toMatch(/^(auto|scroll)$/);
  expect(geometry.nestedScrollOwners, `${name}: no nested CSS scrollports, overflowing or not`).toEqual([]);
  expect(geometry.scrollports.length, `${name}: at most one overflowing owner`).toBeLessThanOrEqual(1);
  expect(geometry.scrollports.every(e => e.isOwner)).toBe(true);
  if (expectOverflow) expect(geometry.scrollports, `${name}: known long content must overflow its owner`).toHaveLength(1);
  expect(geometry.pageExtent).toBeLessThanOrEqual(geometry.pageWidth + 1);
}

async function compactCommand(reader: Locator, evidenceName: string, context: 'row-and-following' | 'mobile-child-row-only' = 'row-and-following') {
  const row = reader.locator(`[data-tool-entry-id="${inputId}:tool-call:command"]`);
  await expect(row.locator('.tool-chip-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(row.locator('.tool-chip-target')).toContainText('npm test -- long_unbroken_argument_');
  await row.scrollIntoViewIfNeeded();
  // The mobile child reader's existing chrome leaves a 126px owner: the
  // measured 118px row fits, but its 181px union with prose cannot. That one
  // scene captures row and prose separately; the global inspector proves the
  // simultaneous mobile scene without altering card chrome or summary metrics.
  await row.evaluate((el, context) => {
    const owner = el.closest<HTMLElement>('.conversation-reading-surface, .chat-scroll-area')!;
    const following = owner.querySelector('[data-entry-id="between"]')!;
    const bounds = owner.getBoundingClientRect(), top = bounds.top + owner.clientTop;
    const footer = document.querySelector('.mobile-pane-switch')!.getBoundingClientRect();
    const bottom = Math.min(top + owner.clientHeight, innerHeight, footer.height > 0 ? footer.top : innerHeight);
    const first = el.getBoundingClientRect(), last = following.getBoundingClientRect();
    const groupHeight = context === 'mobile-child-row-only' ? first.height : last.bottom - first.top;
    owner.scrollTop += first.top - top - Math.max(0, (bottom - top - groupHeight) / 2);
  }, context);
  await row.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const metrics = await row.evaluate(el => {
    const button = el.querySelector<HTMLElement>('.tool-chip-toggle')!, target = el.querySelector<HTMLElement>('.tool-chip-target')!;
    const owner = el.closest<HTMLElement>('.conversation-reading-surface, .chat-scroll-area')!;
    const r = target.getBoundingClientRect(), line = parseFloat(getComputedStyle(target).lineHeight);
    const parts = ['action', 'target', 'status'].map(name => el.querySelector(`.tool-chip-${name}`)!.getBoundingClientRect());
    const bounds = owner.getBoundingClientRect(), whole = el.getBoundingClientRect();
    const following = owner.querySelector(`[data-entry-id="between"]`)!.getBoundingClientRect();
    const footer = document.querySelector('.mobile-pane-switch')!.getBoundingClientRect();
    const ownerTop = bounds.top + owner.clientTop;
    const ownerBottom = Math.min(ownerTop + owner.clientHeight, innerHeight, footer.height > 0 ? footer.top : innerHeight);
    return { width: r.width, height: r.height, line, buttonHeight: button.getBoundingClientRect().height, paneWidth: owner.clientWidth,
      ownerTop, ownerBottom, ownerHeight: ownerBottom - ownerTop, groupHeight: following.bottom - whole.top,
      rowTop: whole.top, rowBottom: whole.bottom, followingTop: following.top, followingBottom: following.bottom,
      font: getComputedStyle(target).fontSize, overflow: button.scrollWidth > button.clientWidth + 1,
      rowVisible: whole.top >= ownerTop && whole.bottom <= ownerBottom,
      visible: whole.top >= ownerTop && whole.bottom <= ownerBottom && following.top >= ownerTop && following.bottom <= ownerBottom,
      overlap: parts.some((a, i) => parts.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)) };
  });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, `${evidenceName}.geometry.json`), JSON.stringify({ ...metrics, context,
    contextLimitation: context === 'mobile-child-row-only' ? 'Existing child header and participant rail: row + following prose cannot fit simultaneously; captured separately. Global mobile inspector supplies simultaneous evidence.' : null }, null, 2));
  if (context === 'row-and-following') {
    expect(metrics.groupHeight, 'actual owner must fit the whole closed row and following prose without footer clipping').toBeLessThanOrEqual(metrics.ownerHeight);
    expect(metrics.visible).toBe(true);
  } else {
    expect(metrics.groupHeight, 'record the evidenced mobile child chrome limitation explicitly').toBeGreaterThan(metrics.ownerHeight);
  }
  expect(metrics.width).toBeGreaterThanOrEqual(64);
  expect(metrics.height).toBeLessThanOrEqual(metrics.line + 1);
  const lines = metrics.paneWidth >= 450 ? 2 : 3;
  expect(metrics.buttonHeight).toBeLessThanOrEqual(lines * metrics.line + 12 + (lines - 1) * 8 + 1);
  expect(metrics.font).toBe('15px'); expect(metrics.overlap).toBe(false); expect(metrics.overflow).toBe(false); expect(metrics.rowVisible).toBe(true);
  return metrics;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1296, height: 899 }, { width: 900, height: 700 }, { width: 390, height: 844 }]) {
  test(`real authenticated retained reading ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await seedTokenBeforeNavigation(page, token);
    const requests: Array<{ method: string; path: string }> = []; const errors: string[] = [];
    page.on('request', r => requests.push({ method: r.method(), path: new URL(r.url()).pathname }));
    page.on('pageerror', e => errors.push(e.message));
    const reads = (session: string) => requests.filter(r => r.method === 'GET' && decodeURIComponent(r.path) === `/api/agents/${session}/current-instructions`).length;
    await page.goto(`${origin}/agents/${executor}`);
    const reader = page.locator('.conversation-container');
    await expect(reader).toContainText('final-transcript-Z');
    expect(requests.filter(r => r.path.endsWith('/current-instructions'))).toEqual([]);
    const apiPath = `/api/agents/${encodeURIComponent(executor)}/conversation`;
    expect((await page.request.get(`${origin}${apiPath}`)).status()).toBe(401);
    const retained = await page.request.get(`${origin}${apiPath}`, { headers: { authorization: `Bearer ${token}` } });
    expect(retained.status()).toBe(200);
    const publicConversation = parseOperatorResponse('agents.conversation', 200, await retained.json());
    expect(publicConversation.segment_context).toBeNull();
    expect(publicConversation.entries.map(e => e.id)).toContain(`${inputId}:tool-result:image`);
    expect(JSON.stringify(publicConversation)).not.toMatch(/provider_projection|producer_account_id|data:image|base64/);
    await expect(reader).toContainText('Image snapshot recorded');
    await orderedContent(reader);
    await expect(reader).toContainText('Synthetic command failed');
    await compactCommand(reader, `${viewport.width}-child-compact-command`, viewport.width === 390 ? 'mobile-child-row-only' : 'row-and-following');
    await capture(page, reader, `${viewport.width}-child-compact-command-default`);
    if (viewport.width === 390) {
      const following = reader.locator('[data-entry-id="between"]');
      await following.scrollIntoViewIfNeeded();
      await following.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      expect(await following.evaluate(el => {
        const owner = el.closest<HTMLElement>('.conversation-reading-surface')!;
        const bounds = owner.getBoundingClientRect(), text = el.getBoundingClientRect();
        const top = bounds.top + owner.clientTop;
        const footer = document.querySelector('.mobile-pane-switch')!.getBoundingClientRect();
        return text.top >= top && text.bottom <= Math.min(top + owner.clientHeight, footer.top);
      }), 'following prose fits separately after ordinary owner scroll').toBe(true);
      await capture(page, reader, '390-child-compact-command-following-separate');
      await page.goto(`${origin}/agents/${analyst}`);
      await expect(page.locator('.global-session-reader')).toBeVisible();
      await expect(reader).toContainText('final-transcript-Z');
      await compactCommand(reader, '390-global-analyst-inspector-compact-command');
      await capture(page, reader, '390-global-analyst-inspector-compact-command-default');
      await page.goto(`${origin}/agents/${executor}`);
      await expect(reader).toContainText('final-transcript-Z');
    }
    await reader.locator('.conversation-reading-surface').evaluate(e => { e.scrollTop = 0; });
    await capture(page, reader, `${viewport.width}-child-current-context-instructions-default`);
    const dto = await instructions(page, reader, executor, false);
    expect(reads(executor)).toBe(2); // exactly open + explicit Refresh
    expect(dto.bindings.map(b => b.kind === 'workflow_node' ? b.node_id : 'global')).toEqual(['execute', 'verify']);
    expect(dto.bindings.every(b => b.instructions.includes('view_image') && b.instructions.endsWith('final-loaded-instructions-Z'))).toBe(true);
    await reader.locator('.conversation-reading-surface').evaluate(e => { e.scrollTop = 0; });
    await capture(page, reader, `${viewport.width}-child-current-instructions-expanded`, true);
    await reader.locator('.current-instructions summary').click();
    await expect(reader.locator('.current-instructions section')).toHaveCount(0);
    const reopened = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/current-instructions'));
    await reader.locator('.current-instructions summary').click(); await reopened;
    expect(reads(executor)).toBe(3); // reopening performs a fresh ordinary read
    await reader.locator('.current-instructions summary').click();
    // Cold exact call and result targets reveal their distinct anchors in one row.
    for (const half of ['call', 'result']) {
      const id = `${inputId}:tool-${half}:command`;
      await page.goto(`${origin}/agents/${executor}?segment=1&entry=${encodeURIComponent(id)}`);
      const anchor = reader.locator(`[data-entry-id="${id}"]`);
      await expect(anchor).toBeFocused();
      await expect(reader.locator(`[data-tool-entry-id="${inputId}:tool-call:command"]`)).toHaveCount(1);
      await expect(reader).toContainText('Result recorded later');
      if (half === 'result') {
        const exchange = reader.locator(`[data-tool-entry-id="${inputId}:tool-call:command"]`);
        await expect(exchange.locator('.tool-chip-status')).toContainText('Exited');
        await expect(exchange.locator('.tool-chip-status')).toContainText('exit 0');
        await expect(exchange.locator('.tool-chip-status')).not.toContainText('Passed');
        await anchor.locator('details:not(.safe-original)').evaluateAll(es => es.forEach(e => { (e as HTMLDetailsElement).open = true; }));
        const outputs = anchor.locator('.semantic-section details[open] pre');
        await expect(outputs).toHaveCount(2);
        await expect(outputs.nth(0)).toBeVisible();
        await expect(outputs.nth(1)).toBeVisible();
        await expect(anchor).toContainText('final-stdout-Z');
        await expect(anchor).toContainText('final-stderr-Q');
        await capture(page, reader, `${viewport.width}-child-exact-command-output-expanded`, true);
      }
      await anchor.locator('details.safe-original').evaluate(e => { (e as HTMLDetailsElement).open = true; });
      const raw = anchor.locator('details.safe-original');
      await expect(raw.locator('pre')).toContainText(half === 'call' ? retainedCommand : 'final-stdout-Z');
      const safeReceived = await raw.locator('pre').textContent();
      await raw.getByRole('button', { name: 'copy', exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(safeReceived);
      await capture(page, reader, `${viewport.width}-child-exact-command-${half}-raw-expanded`, true);
    }
    await page.goto(`${origin}/agents/${executor}?segment=1&entry=${encodeURIComponent(`${inputId}:tool-result:image`)}`);
    const image = reader.locator(`[data-entry-id="${inputId}:tool-result:image"]`);
    await expect(image).toBeFocused();
    await image.locator('details.safe-original').evaluate(e => { (e as HTMLDetailsElement).open = true; });
    await expect(image.locator('details.safe-original pre')).toContainText(imageDescriptor.sha256);
    await expect(image.locator('details.safe-original pre')).toContainText(imageDescriptor.id);
    await expect(image.locator('a')).toHaveCount(0);
    await expect(reader.locator('img')).toHaveCount(0);
    await capture(page, reader, `${viewport.width}-image-metadata`);
    const catalog = readConversationCatalog(root, planner);
    for (const version of [null, 1, 2, 3]) {
      await page.goto(`${origin}/agents/${planner}${version ? `?segment=${version}` : ''}`);
      await expect(reader).toContainText(`Conversation · ${version ? 'exact' : 'current'} segment ${version ?? catalog.currentVersion}`);
      expect(reads(planner)).toBe(version === null ? 0 : version === 3 ? 4 : 2);
      const selection = version === null ? 'current' : `exact-${version}`;
      await reader.locator('.conversation-reading-surface').evaluate(e => { e.scrollTop = 0; });
      await expect(reader.locator('.current-instructions')).not.toHaveAttribute('open');
      if (version !== 1) await expect(reader.locator('[data-testid="conversation-segment-context"]')).not.toHaveAttribute('open');
      await capture(page, reader, `${viewport.width}-planner-${selection}-context-instructions-default`);
      if (version !== 1) {
        const context = reader.locator('[data-testid="conversation-segment-context"]');
        await expect(context).toContainText('Compacted context');
        await context.evaluate(e => { const d = e.closest('details'); if (d) d.open = true; e.querySelectorAll('details').forEach(d => { d.open = true; }); });
        await expect(context).toContainText('final-summary-Z');
        await expect(context).toContainText(version === 2 ? 'first-protected-Z' : 'final-protected-Z');
        await capture(page, reader, `${viewport.width}-planner-${selection}-context-expanded`, true);
      } else await expect(reader.locator('[data-testid="conversation-segment-context"]')).toHaveCount(0);
      const history = reader.locator('details.version-history');
      if (await history.getAttribute('open') === null) await history.locator('summary').click();
      await expect(reader.getByRole('button', { name: /Segment 1/ })).toBeVisible();
      if (version === null || version === 2) {
        await instructions(page, reader, planner, version !== null);
        await reader.locator('.conversation-reading-surface').evaluate(e => { e.scrollTop = 0; });
        await capture(page, reader, `${viewport.width}-planner-${selection}-context-instructions-expanded`, true);
      }
      if (version === 2) {
        // Exercise actual history controls and browser Back, not cold routes alone.
        await history.getByRole('button', { name: /Segment 1/ }).click();
        await expect(reader).toContainText('Conversation · exact segment 1');
        await expect(reader.locator('[data-testid="conversation-segment-context"]')).toHaveCount(0);
        await page.goBack();
        await expect(reader).toContainText('Conversation · exact segment 2');
        await expect(reader.locator('.current-instructions')).toContainText('not the instructions recorded for this historical segment');
        expect(reads(planner)).toBe(4); // same-session history does not refetch current configuration
      }
    }
    if (viewport.width === 390) await page.getByRole('navigation', { name: 'Switch pane' }).getByRole('button', { name: 'Analyst', exact: true }).click();
    const chat = page.locator('.analyst-chat-panel');
    await expect(chat).toContainText('final-transcript-Z');
    await expect(chat).toContainText('Image snapshot recorded');
    await orderedContent(chat);
    await compactCommand(chat, `${viewport.width}-shared-analyst-compact-command`);
    await capture(page, chat, `${viewport.width}-shared-analyst-compact-command-default`);
    expect(reads(analyst)).toBe(0);
    await chat.locator('.chat-scroll-area').evaluate(e => { e.scrollTop = 0; });
    await capture(page, chat, `${viewport.width}-shared-analyst-current-instructions-default`);
    await instructions(page, chat, analyst, false);
    expect(reads(analyst)).toBe(2);
    await chat.locator('.chat-scroll-area').evaluate(e => { e.scrollTop = 0; });
    await capture(page, chat, `${viewport.width}-shared-analyst-current-instructions-expanded`, true);
    expect(requests.some(r => /\/images\/|synthetic-screen\.png/.test(r.path))).toBe(false);
    // GET /api/chat is the mounted Analyst's legitimate retained baseline read.
    // The real authenticated WS lease also obtains its existing ephemeral auth
    // ticket via POST; that is not a target-history mutation or chat submission.
    expect(requests.filter(r => r.path === '/api/chat' && r.method !== 'GET')).toEqual([]);
    expect(requests.filter(r => r.path.startsWith('/api/') && !['GET', 'HEAD'].includes(r.method)
      && !(r.method === 'POST' && r.path === '/api/auth/ws-ticket'))).toEqual([]);
    expect(errors).toEqual([]); expect(providerRequests).toEqual([]);
    writeFileSync(join(evidence, `${viewport.width}-requests.json`), JSON.stringify(requests, null, 2));
  });
}
