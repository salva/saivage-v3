import { ENVELOPE_SCHEMAS, type EnvelopeBearingRole } from './role-envelope-schemas.js';
import { zodToJsonSchemaMini, type JsonSchema } from './zod-to-jsonschema-mini.js';

export const ROLE_RESULT_TOOL_NAMES: Record<EnvelopeBearingRole, string> = {
  planner: 'emit_planner_result',
  executor: 'emit_executor_result',
  reviewer: 'emit_reviewer_result',
};

export interface RoleResultToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

function buildToolDef(role: EnvelopeBearingRole): RoleResultToolDefinition {
  return {
    type: 'function',
    function: {
      name: ROLE_RESULT_TOOL_NAMES[role],
      description: `Emit the ${role} result envelope as the final action of this turn.`,
      parameters: zodToJsonSchemaMini(ENVELOPE_SCHEMAS[role]),
    },
  };
}

export const EMIT_PLANNER_RESULT: RoleResultToolDefinition = buildToolDef('planner');
export const EMIT_EXECUTOR_RESULT: RoleResultToolDefinition = buildToolDef('executor');
export const EMIT_REVIEWER_RESULT: RoleResultToolDefinition = buildToolDef('reviewer');

export const ROLE_RESULT_TOOLS: Record<EnvelopeBearingRole, RoleResultToolDefinition> = {
  planner: EMIT_PLANNER_RESULT,
  executor: EMIT_EXECUTOR_RESULT,
  reviewer: EMIT_REVIEWER_RESULT,
};
