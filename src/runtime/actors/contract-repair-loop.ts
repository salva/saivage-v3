import type { LLMActorOutcome } from './llm-actor.js';

type ToolCallOutcome = Extract<LLMActorOutcome, { type: 'tool_call' }>;

export type ContractRepairStep<T> =
  | { kind: 'continue'; outcome: LLMActorOutcome }
  | { kind: 'done'; value: T }
  | { kind: 'restart' };

export type ContractRepairLoopResult<T> =
  | { kind: 'done'; value: T }
  | { kind: 'restart' };

export interface ContractRepairControl<T> {
  done(value: T): ContractRepairStep<T>;
  continue(outcome: LLMActorOutcome): ContractRepairStep<T>;
  restart(): ContractRepairStep<T>;
  repair(next: () => Promise<LLMActorOutcome>): Promise<ContractRepairStep<T>>;
}

export async function runContractRepairLoop<T>(args: {
  initialOutcome: LLMActorOutcome;
  isTerminalToolName: (name: string) => boolean;
  fail: (message: string) => T | Promise<T>;
  onPlainText: (outcome: Extract<LLMActorOutcome, { type: 'result' }>, control: ContractRepairControl<T>) => Promise<ContractRepairStep<T>> | ContractRepairStep<T>;
  onTerminalTool: (outcome: ToolCallOutcome, control: ContractRepairControl<T>) => Promise<ContractRepairStep<T>> | ContractRepairStep<T>;
  onNonTerminalTool: (outcome: ToolCallOutcome) => Promise<LLMActorOutcome>;
}): Promise<ContractRepairLoopResult<T>> {
  let outcome = args.initialOutcome;

  const control: ContractRepairControl<T> = {
    done: (value) => ({ kind: 'done', value }),
    continue: (nextOutcome) => ({ kind: 'continue', outcome: nextOutcome }),
    restart: () => ({ kind: 'restart' }),
    repair: async (next) => ({ kind: 'continue', outcome: await next() }),
  };

  for (;;) {
    let step: ContractRepairStep<T>;
    if (outcome.type === 'result') {
      step = await args.onPlainText(outcome, control);
    } else if (outcome.type === 'error') {
      return { kind: 'done', value: await args.fail(outcome.error) };
    } else if (args.isTerminalToolName(outcome.toolName)) {
      step = await args.onTerminalTool(outcome, control);
    } else {
      step = control.continue(await args.onNonTerminalTool(outcome));
    }

    if (step.kind === 'done' || step.kind === 'restart') return step;
    outcome = step.outcome;
  }
}
