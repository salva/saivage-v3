import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const openingBrace = source.indexOf('{', start);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  throw new Error(`Unclosed source body for '${signature}'.`);
}

describe('card activation admission projection call graph', () => {
  it('uses one plain activation-owner map with no callback or readiness authority outside the supervisor', () => {
    const supervisor = readFileSync(join(root, 'src/runtime/actors/supervisor-runtime-api.ts'), 'utf8');
    const owner = readFileSync(join(root, 'src/runtime/actors/card-activation-owner.ts'), 'utf8');
    const provider = readFileSync(join(root, 'src/tools/planner-control-provider.ts'), 'utf8');
    const control = readFileSync(join(root, 'src/application/runtime-control-service.ts'), 'utf8');
    const composition = readFileSync(join(root, 'src/application/runtime-composition.ts'), 'utf8');
    expect(supervisor).toContain('activationOwners = new Map<string, CardActivationOwner>()');
    expect(supervisor).not.toMatch(/cardActors|liveCardActors/);
    expect(owner).not.toContain('BaseActor');
    expect(provider).not.toMatch(/readActivationAdmission|beginStructuralWait|endStructuralWait|children\.get/);
    expect(provider).toContain('parentControl.activateChild'); expect(provider).toContain('parentControl.cancelChild');
    for (const source of [control, composition]) expect(source).not.toMatch(/markNotReady|markPausedReady|markStoppedReady/);
    expect(control).not.toContain('RuntimeInterventionBinding');
  });

  it('keeps one required actor-built LLM invocation context contract', () => {
    const invocation = readFileSync(join(root, 'src/tools/invocation.ts'), 'utf8');
    const snapshot = readFileSync(join(root, 'src/runtime/actors/executing-llm-snapshot.ts'), 'utf8');
    const llm = readFileSync(join(root, 'src/runtime/actors/llm-actor.ts'), 'utf8');
    const autonomous = readFileSync(join(root, 'src/runtime/actors/agent-node-execution.ts'), 'utf8');
    const analyst = readFileSync(join(root, 'src/agents/analyst-handler.ts'), 'utf8');

    expect(invocation).toMatch(/invokeToolForLlm\(surface: InvocationSurface, name: string, args: unknown, context: LlmToolInvocationContext, signal\?: AbortSignal\)/);
    expect(invocation).not.toMatch(/invokeToolForLlm\([^\n]*context\?: LlmToolInvocationContext/);
    expect(snapshot).toMatch(/readonly childInvocation: ChildInvocationReservation/);
    expect(snapshot).not.toMatch(/waitChild|waitCallbacks/);
    expect(llm).toContain('toolInvocationContext(outcome');
    expect(llm).not.toContain('waitCallbacks');
    expect(autonomous).toContain('llm.toolInvocationContext(toolOutcome)');
    expect(analyst).toContain('this.#llm.toolInvocationContext(outcome)');
    expect(analyst).toContain('invokeToolForLlm(surface, outcome.toolName, parsed.args');
    expect(analyst).not.toMatch(/childInvocation\s*:/);
  });

  it('uses exact target and dependency reads without list or tree projection', () => {
    const serviceSource = readFileSync(join(root, 'src/cards/card-service.ts'), 'utf8');
    const admission = functionBody(serviceSource, 'readActivationAdmission(cardId: string)');
    expect(admission).toMatch(/this\.read\(cardId\)/);
    expect(admission).toMatch(/child\.depends_on\.map/);
    for (const forbidden of [/this\.state\s*\(/, /this\.list\s*\(/, /listCards\s*\(/]) {
      expect(admission).not.toMatch(forbidden);
    }
  });
});
