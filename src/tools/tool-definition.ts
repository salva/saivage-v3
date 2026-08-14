import { z } from 'zod';

import { analystIssueSeverityValues, cardStatusValues, cardTypeValues, urgencyValues } from '../schemas/index.js';
import { emptyToolInputSchema } from '../contracts/builtin-tool-inputs.js';

export const CARD_STATUS_VALUES = cardStatusValues;
export const CARD_TYPE_VALUES = cardTypeValues;
export const CREATE_CARD_TYPE_VALUES = CARD_TYPE_VALUES;
export const URGENCY_VALUES = urgencyValues;
export const ANALYST_ISSUE_SEVERITY_VALUES = analystIssueSeverityValues;

export function describe<T extends z.ZodTypeAny>(schema: T, description: string): T {
  return schema.describe(description) as T;
}

export const emptyInput = emptyToolInputSchema;
