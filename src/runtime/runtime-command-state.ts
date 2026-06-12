import type { ActionableErrorEnvelope, RuntimeCommandRecord, RuntimeState } from '../schemas/index.js';

export function buildRejectedRuntimeCommandState(input: {
  state: RuntimeState;
  command: RuntimeCommandRecord;
  error: ActionableErrorEnvelope;
  at: string;
}): { rejectedCommand: RuntimeCommandRecord; state: RuntimeState } {
  const rejectedCommand: RuntimeCommandRecord = {
    ...input.command,
    status: 'rejected',
    completed_at: input.at,
    error: input.error,
  };
  return {
    rejectedCommand,
    state: {
      ...input.state,
      runtime_commands: input.state.runtime_commands.map((item) =>
        item.command_id === input.command.command_id ? rejectedCommand : item,
      ),
      updated_at: input.at,
    },
  };
}

export function buildCompletedRuntimeCommandState(input: {
  state: RuntimeState;
  command: RuntimeCommandRecord;
  at: string;
  statePatch?: Partial<RuntimeState>;
}): { completedCommand: RuntimeCommandRecord; state: RuntimeState } {
  const completedCommand: RuntimeCommandRecord = {
    ...input.command,
    status: 'completed',
    completed_at: input.at,
  };
  return {
    completedCommand,
    state: {
      ...input.state,
      ...input.statePatch,
      runtime_commands: input.state.runtime_commands.map((item) =>
        item.command_id === input.command.command_id ? completedCommand : item,
      ),
      updated_at: input.at,
    },
  };
}
