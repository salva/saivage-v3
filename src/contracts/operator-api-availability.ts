import { z } from 'zod';

export const AvailabilityStateSchema = z.enum(['available', 'degraded', 'idle', 'unavailable', 'unknown']);
export const AvailabilityComponentSourceSchema = z.enum(['startup', 'runtime-application', 'mcp-manager', 'health-check', 'unknown']);
export const AvailabilityDiagnosticSchema = z.object({
  code: z.string().min(1),
  summary: z.string().min(1).max(240),
});
export const AvailabilityComponentSchema = z.object({
  state: AvailabilityStateSchema,
  source: AvailabilityComponentSourceSchema,
  checkedAt: z.string().datetime(),
  diagnostic: AvailabilityDiagnosticSchema.optional(),
});
export const ServerAvailabilitySchema = z.object({
  generatedAt: z.string().datetime(),
  components: z.object({
    api: AvailabilityComponentSchema,
    runtime: AvailabilityComponentSchema,
    mcp: AvailabilityComponentSchema,
  }),
});

export type AvailabilityState = z.infer<typeof AvailabilityStateSchema>;
export type AvailabilityComponent = z.infer<typeof AvailabilityComponentSchema>;
export type ServerAvailability = z.infer<typeof ServerAvailabilitySchema>;
