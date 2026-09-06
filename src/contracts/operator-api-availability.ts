import { z } from 'zod';

export const AvailabilityStateSchema = z.enum(['available', 'degraded', 'idle', 'unknown']);
export const AvailabilityComponentSourceSchema = z.enum(['runtime-application', 'mcp-manager', 'health-check']);
const AvailabilityDiagnosticSchema = z.object({
  code: z.string().min(1),
  summary: z.string().min(1).max(240),
}).strict();
const AvailabilityComponentSchema = z.object({
  state: AvailabilityStateSchema,
  source: AvailabilityComponentSourceSchema,
  checkedAt: z.string().datetime(),
  diagnostic: AvailabilityDiagnosticSchema.optional(),
}).strict();
export const ServerAvailabilitySchema = z.object({
  generatedAt: z.string().datetime(),
  components: z.object({
    api: AvailabilityComponentSchema,
    runtime: AvailabilityComponentSchema,
    mcp: AvailabilityComponentSchema,
  }).strict(),
}).strict();

export type ServerAvailability = z.infer<typeof ServerAvailabilitySchema>;
