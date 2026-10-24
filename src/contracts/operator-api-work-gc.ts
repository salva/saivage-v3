import { WorkGcRequestSchema, WorkGcResponseSchema, WorkGcBusyErrorSchema } from './work-gc.js';
import {
  operatorSessionContract,
  ValidationErrorSchema,
  UnauthorizedErrorSchema,
  UnexpectedInternalServerErrorSchema,
} from './operator-api-core.js';

export const workGcOperatorApiContracts = {
  'runtime.gcWork': {
    operationId: 'runtime.gcWork',
    method: 'POST',
    path: '/api/runtime/gc-work',
    body: WorkGcRequestSchema,
    success: WorkGcResponseSchema,
    response: {
      200: WorkGcResponseSchema,
      400: ValidationErrorSchema,
      401: UnauthorizedErrorSchema,
      409: WorkGcBusyErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    ...operatorSessionContract,
  },
} as const;
