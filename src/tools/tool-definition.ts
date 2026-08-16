import { z } from 'zod';

import { analystIssueSeverityValues, cardStatusValues, urgencyValues } from '../schemas/index.js';
import { emptyToolInputSchema } from '../contracts/builtin-tool-inputs.js';

export const CARD_STATUS_VALUES = cardStatusValues;
export const URGENCY_VALUES = urgencyValues;
export const ANALYST_ISSUE_SEVERITY_VALUES = analystIssueSeverityValues;

export function describe<T extends z.ZodTypeAny>(schema: T, description: string): T {
  return schema.describe(description) as T;
}

export const emptyInput = emptyToolInputSchema;
