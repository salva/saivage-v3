import { agentExecution } from '../helpers/workflow-execution.js';
import { expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFF_SYSTEM_TEMPLATES as SYSTEM_TEMPLATES } from '../helpers/system-template-config.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { compileProjectWorkflows, describeNodeResultContract } from '../../src/runtime/card-process/card-process-config.js';
import { renderCompiledPrompt } from '../../src/utils/prompt-api.js';
import { BoundAgentToolSet } from '../../src/tools/runtime-tool-catalog.js';
import { surfaceToolDefinitions } from '../../src/tools/invocation.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';

it.each(SYSTEM_TEMPLATES)('renders $name selected role/generated-contract/node context offline with opted-in and denied surfaces', template => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-refresh-prompt-'));
  try {
    const config = effectiveSaivageConfigSchema.parse(structuredClone(template.config));
    config.agents.executor!.tools.push('mcp_catalog_refresh');
    const compiled = compileProjectWorkflows(config, { projectRoot: root, defaultPromptRoot: template.promptRoot });
    const renders: Array<{ role: string; roleText: string; nodeText?: string; toolNames: string[] }> = [];
    for (const role of ['executor', 'reviewer']) {
      const selected = [...compiled.cardTypes].flatMap(([cardType, process]) => [...process.states].flatMap(([stateId, state]) => state.kind === 'node' && agentExecution(state).agent.name === role ? [{ cardType, process, stateId, state }] : []))[0]!;
      expect(selected).toBeDefined();
      const { cardType, process, stateId, state } = selected;
      const contract = describeNodeResultContract(process, stateId);
      const roleText = renderCompiledPrompt({ kind: 'workflow-agent', cardType }, agentExecution(state).agent.name, agentExecution(state).selectedAgentPrompt.compiled, { contractDescription: contract });
      const nodeText = process.processPrompts.get(agentExecution(state).prompt.promptId)!.text;
      const refs = agentExecution(state).agent.tools.filter(tool => tool.name.startsWith('mcp_'));
      const surface = new BoundAgentToolSet(refs).bind({ scope: 'card', agentName: agentExecution(state).agent.name, projectRoot: root, mcpToolInvocation: unusedMcpToolInvocation } as never);
      const definitions = surfaceToolDefinitions(surface);
       const toolNames = definitions.map(tool => tool.function.name);
       expect(toolNames).toEqual(refs.map(tool => tool.name));
      if (role === 'executor') {
        expect(toolNames).toContain('mcp_catalog_refresh');
        expect(definitions.find(tool => tool.function.name === 'mcp_tool_call')!.function.parameters).toMatchObject({ required: expect.arrayContaining(['bindingId', 'catalogId']) });
      } else expect(toolNames).toEqual([]);
      expect(roleText.split(contract)).toHaveLength(2);
      expect(nodeText.length).toBeGreaterThan(0);
      renders.push({ role, roleText, nodeText, toolNames });
    }
    const analystText = renderCompiledPrompt({ kind: 'global-agent' }, compiled.analyst.name, compiled.analystPrompt.compiled, { vocabularySnippet: 'Offline vocabulary orientation; no project data.' });
    renders.push({ role: 'analyst', roleText: analystText, toolNames: compiled.analyst.tools.map(tool => tool.name) });
    expect(renders[2]!.toolNames).not.toContain('mcp_catalog_refresh');
    expect(renders.map(render => render.role)).toEqual(['executor', 'reviewer', 'analyst']);
    const oversightText = renderCompiledPrompt({ kind: 'global-agent' }, compiled.oversight.name, compiled.oversightPrompt.compiled, { vocabularySnippet: 'Offline vocabulary orientation; no project data.' });
    renders.push({ role:'oversight', roleText:oversightText, toolNames:compiled.oversight.tools.map(tool=>tool.name) });
    const evidence = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
    if (evidence) { mkdirSync(evidence, {recursive:true}); writeFileSync(join(evidence, `mcp-${template.name}.json`), JSON.stringify(renders,null,2)); }
    // Existing compiler rendering, generated input schemas and selected inventories
    // are the evidence. No prose keyword test substitutes for whole-composition review.
    for (const render of renders) expect(render.roleText.length).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true }); }
});
