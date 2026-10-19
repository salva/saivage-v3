import { z } from 'zod';

import { cardStatusValues, urgencyValues } from '../schemas/index.js';
import { emptyToolInputSchema } from '../contracts/index.js';

export const CARD_STATUS_VALUES = cardStatusValues;
export const URGENCY_VALUES = urgencyValues;

export function describe<T extends z.ZodTypeAny>(schema: T, description: string): T {
  return schema.describe(description) as T;
}

export const emptyInput = emptyToolInputSchema;
