import { z } from 'zod';

import { analystIssueSeverityValues, cardStatusValues, cardTypeValues, urgencyValues } from '../schemas/index.js';
import type { AgentRole } from '../schemas/index.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';

export type { AgentRole };

export const CARD_STATUS_VALUES = cardStatusValues;
export const RUNTIME_CARD_STATUS_VALUES = CARD_STATUS_VALUES.filter((status) => status !== 'needs_verification') as [
  'backlog',
  'running',
  'blocked',
  'changed',
  'done',
  'failed',
  'cancelled',
];
export const CARD_TYPE_VALUES = cardTypeValues;
export const PLANNER_CREATE_CARD_TYPE_VALUES = ['goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] as const;
export const CREATE_CARD_TYPE_VALUES = CARD_TYPE_VALUES;
export const URGENCY_VALUES = urgencyValues;
export const NOTE_KIND_VALUES = ['comment', 'progress', 'directive', 'escalation'] as const;
export const ANALYST_ISSUE_SEVERITY_VALUES = analystIssueSeverityValues;

export type ToolExecutor<Input> = (ctx: ToolContext, params: Input) => Promise<ToolResult>;

export interface UnifiedToolDefinition<Name extends string = string, Input = unknown> {
  readonly name: Name;
  readonly description: string;
  readonly input: z.ZodType<Input>;
  readonly roles: readonly AgentRole[];
  readonly executor?: ToolExecutor<Input>;
  readonly plannerControl?: boolean;
  readonly plannerInput?: z.ZodTypeAny;
  readonly plannerDescription?: string;
  readonly workspace?: boolean;
  readonly skill?: boolean;
  readonly mcpWrapper?: boolean;
}

export function describe<T extends z.ZodTypeAny>(schema: T, description: string): T {
  return schema.describe(description) as T;
}

export function enumSchema<T extends readonly [string, ...string[]]>(description: string, values: T): z.ZodEnum<[T[0], ...string[]]> {
  return describe(z.enum([...values] as [T[0], ...string[]]), `${description} Allowed values: ${values.join(', ')}.`);
}

export const stringArraySchema = z.array(describe(z.string(), 'A string value.'));
export const cardIdArraySchema = z.array(describe(z.string(), 'A card ID'));
export const cardStatusSchema = enumSchema('Card status.', CARD_STATUS_VALUES);
export const runtimeCardStatusSchema = enumSchema('Card status.', RUNTIME_CARD_STATUS_VALUES);
export const cardTypeSchema = enumSchema('Card type.', CARD_TYPE_VALUES);
export const plannerCreateCardTypeSchema = describe(z.enum([...PLANNER_CREATE_CARD_TYPE_VALUES] as [typeof PLANNER_CREATE_CARD_TYPE_VALUES[0], ...string[]]), 'The card type.');
export const urgencySchema = enumSchema('Urgency level.', URGENCY_VALUES);
export const analystIssueSeveritySchema = enumSchema('Optional issue severity.', ANALYST_ISSUE_SEVERITY_VALUES);
export const emptyInput = z.object({}).strict();
