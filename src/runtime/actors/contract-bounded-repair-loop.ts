import type { LLMActorOutcome } from './llm-actor.js';

export const MAX_TERMINAL_CONTRACT_REPAIRS = 2;

type ToolCallOutcome = Extract<LLMActorOutcome, { type: 'tool_call' }>;

export type ContractRepairStep<T> =
  | { kind: 'continue'; outcome: LLMActorOutcome }
  | { kind: 'done'; value: T };

export interface ContractRepairControl<T> {
  done(value: T): ContractRepairStep<T>;
  continue(outcome: LLMActorOutcome): ContractRepairStep<T>;
  repair(message: string, next: () => Promise<LLMActorOutcome>): Promise<ContractRepairStep<T>>;
}

export async function runContractBoundedRepairLoop<T>(args: {
  initialOutcome: LLMActorOutcome;
  isTerminalToolName: (name: string) => boolean;
  fail: (message: string) => T | Promise<T>;
  onPlainText: (outcome: Extract<LLMActorOutcome, { type: 'result' }>, control: ContractRepairControl<T>) => Promise<ContractRepairStep<T>> | ContractRepairStep<T>;
  onTerminalTool: (outcome: ToolCallOutcome, control: ContractRepairControl<T>) => Promise<ContractRepairStep<T>> | ContractRepairStep<T>;
  onNonTerminalTool: (outcome: ToolCallOutcome) => Promise<LLMActorOutcome>;
}): Promise<T> {
  let outcome = args.initialOutcome;
  let repairAttempts = 0;

  const control: ContractRepairControl<T> = {
    done: (value) => ({ kind: 'done', value }),
    continue: (nextOutcome) => ({ kind: 'continue', outcome: nextOutcome }),
    repair: async (message, next) => {
      if (repairAttempts >= MAX_TERMINAL_CONTRACT_REPAIRS) return { kind: 'done', value: await args.fail(message) };
      repairAttempts++;
      return { kind: 'continue', outcome: await next() };
    },
  };

  for (;;) {
    let step: ContractRepairStep<T>;
    if (outcome.type === 'result') {
      step = await args.onPlainText(outcome, control);
    } else if (outcome.type === 'error') {
      return args.fail(outcome.error);
    } else if (args.isTerminalToolName(outcome.toolName)) {
      step = await args.onTerminalTool(outcome, control);
    } else {
      step = control.continue(await args.onNonTerminalTool(outcome));
    }

    if (step.kind === 'done') return step.value;
    outcome = step.outcome;
  }
}
