import { z } from 'zod';

const component = '[a-z][a-z0-9-]{0,47}';
export const operationNamespaceSchema = z.string().regex(new RegExp(`^${component}$`, 'u'));
export const operationKeySchema = z
  .string()
  .regex(new RegExp(`^${component}(?:\\.${component})*$`, 'u'));
export const operationIdSchema = z
  .string()
  .regex(new RegExp(`^${component}(?:\\.${component})+$`, 'u'));
