import { z } from 'zod';
import {
  WorkGcRequestSchema,
  WorkGcResponseSchema,
  WorkGcBusyErrorSchema,
  WorkGcFrameSchema,
  WorkGcStatusSchema,
} from './work-gc.js';
import {
  operatorSessionContract,
  ValidationErrorSchema,
  UnauthorizedErrorSchema,
  UnexpectedInternalServerErrorSchema,
} from './operator-api-core.js';

const WorkGcStatusForbiddenSchema = z
  .object({
    error: z.literal('Forbidden'),
    message: z.literal('Work garbage collection status requires operator authentication.'),
  })
  .strict();

export const WORK_GC_STATUS_FORBIDDEN = WorkGcStatusForbiddenSchema.parse({
  error: 'Forbidden',
  message: 'Work garbage collection status requires operator authentication.',
});

export const workGcOperatorApiContracts = {
  'runtime.gcWorkStatus': {
    operationId: 'runtime.gcWorkStatus',
    method: 'GET',
    path: '/api/runtime/gc-work/status',
    success: WorkGcStatusSchema,
    response: {
      200: WorkGcStatusSchema,
      400: ValidationErrorSchema,
      401: UnauthorizedErrorSchema,
      403: WorkGcStatusForbiddenSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    ...operatorSessionContract,
  },
  'runtime.gcWork': {
    operationId: 'runtime.gcWork',
    method: 'POST',
    path: '/api/runtime/gc-work',
    body: WorkGcRequestSchema,
    success: WorkGcResponseSchema,
    responseEncoding: 'ndjson',
    response: {
      200: WorkGcFrameSchema,
      400: ValidationErrorSchema,
      401: UnauthorizedErrorSchema,
      409: WorkGcBusyErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    ...operatorSessionContract,
  },
} as const;
