import { describe, expect, it } from '@jest/globals';
import { activateCardArgumentsSchema } from '../../src/contracts/tool-api.js';
import { parseActivationOpenPayload } from '../../src/schemas/activation-instructions.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';

const id = '00000000-0000-4000-8000-000000000001';
const timestamp = '2026-10-13T00:00:00.000Z';
const session = 'agent:executor:card-a' as const;
function marker() {
  return {
    event: 'activation_open',
    agent_name: 'executor',
    card_id: 'card-a',
    input_id: id,
    timestamp,
    instructions: {
      kind: 'prepared',
      role_text: 'Actual role',
      activation_id: id,
      caller: {
        kind: 'parent',
        cardId: 'project',
        sessionId: 'agent:planner:project',
        sourceInputId: id,
        toolCallId: 'actual-call',
        toolName: 'activate_card',
      },
      card: { cardId: 'card-a', cardType: 'code', title: 'Actual orientation' },
      parent_direction: { text: 'Actual rendered parent direction\n  quoted bytes  ' },
      node: { node_id: 'work', text: 'Actual node' },
    },
  };
}

describe('explicit activation and public notification contract', () => {
  it.each([undefined, '', ' \t\n'])('rejects missing/blank direction %p', (instructions) => {
    expect(activateCardArgumentsSchema.safeParse({ card_id: 'card-a', instructions }).success).toBe(
      false,
    );
  });
  it('preserves direction bytes and rejects authority fields', () => {
    const args = { card_id: 'card-a', instructions: '  Correct the gap.\n{{quoted-data}}  ' };
    expect(activateCardArgumentsSchema.parse(args)).toEqual(args);
    expect(activateCardArgumentsSchema.safeParse({ ...args, parent: 'project' }).success).toBe(
      false,
    );
  });
  it('strictly consumes named actual parent provenance without consulting templates', () => {
    const value = marker();
    expect(parseActivationOpenPayload(JSON.stringify(value), session, timestamp)).toEqual(value);
    value.instructions.caller.cardId = 'card-b';
    expect(() => parseActivationOpenPayload(JSON.stringify(value), session, timestamp)).toThrow();
  });
  it('rejects old prepared shape and missing parent direction', () => {
    const value = marker();
    expect(() =>
      parseActivationOpenPayload(
        JSON.stringify({
          ...value,
          instructions: { kind: 'prepared', role_text: 'old', node: value.instructions.node },
        }),
        session,
        timestamp,
      ),
    ).toThrow();
    expect(() =>
      parseActivationOpenPayload(
        JSON.stringify({
          ...value,
          instructions: { ...value.instructions, caller: { kind: 'root' }, parent_direction: null },
        }),
        session,
        timestamp,
      ),
    ).toThrow();
    expect(() =>
      parseActivationOpenPayload(
        JSON.stringify({
          ...value,
          instructions: { ...value.instructions, parent_direction: null },
        }),
        session,
        timestamp,
      ),
    ).toThrow();
  });
  it('has no card notification binder while preserving global selection', () => {
    expect(() => resolveRuntimeTool('card', 'queue_notification')).toThrow();
    expect(resolveRuntimeTool('global', 'queue_notification').name).toBe('queue_notification');
  });
  it('allows renamed selected globals but rejects every nonselected producer', () => {
    const config = effectiveSaivageConfigSchema.parse(structuredClone(DEFAULT_SAIVAGE_CONFIG));
    config.agents['chosen-analyst'] = config.agents.analyst!;
    config.agents['chosen-oversight'] = config.agents.oversight!;
    delete config.agents.analyst;
    delete config.agents.oversight;
    config.analyst_agent = 'chosen-analyst';
    config.oversight.agent = 'chosen-oversight';
    const compiled = compileProjectWorkflows(config);
    expect(compiled.analyst.name).toBe('chosen-analyst');
    expect(compiled.oversight.name).toBe('chosen-oversight');
    for (const original of ['analyst', 'oversight'] as const) {
      config.agents[original] = {
        ...config.agents[original === 'analyst' ? 'chosen-analyst' : 'chosen-oversight']!,
      };
      expect(() => compileProjectWorkflows(config)).toThrow(/configured Analyst or Oversight/);
      delete config.agents[original];
    }
    config.agents.unused = { ...config.agents['chosen-oversight']! };
    expect(() => compileProjectWorkflows(config)).toThrow(/configured Analyst or Oversight/);
    delete config.agents.unused;
    config.agents.planner!.tools.push('queue_notification');
    expect(() => compileProjectWorkflows(config)).toThrow(/configured Analyst or Oversight/);
  });
});
