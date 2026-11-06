import { z } from 'zod';

const capabilityScopeSchema = z.enum(['self', 'children', 'descendants', 'all']);
const scopesSchema = z
  .array(capabilityScopeSchema)
  .min(1)
  .refine((scopes) => new Set(scopes).size === scopes.length, 'Duplicate capability scope.');
const recordPatternSchema = z.union([
  z.literal('*'),
  z
    .string()
    .regex(
      /^[a-z*][a-z0-9*-]{0,63}\.md$/u,
      'Expected a bounded lowercase Markdown record-name glob.',
    ),
]);
export const capabilityResourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('card'), scopes: scopesSchema }).strict(),
  z
    .object({
      kind: z.literal('record'),
      scopes: scopesSchema,
      patterns: z
        .array(recordPatternSchema)
        .min(1)
        .refine(
          (patterns) => new Set(patterns).size === patterns.length,
          'Duplicate record pattern.',
        ),
    })
    .strict(),
  z.object({ kind: z.literal('workspace') }).strict(),
]);
export const agentCapabilitiesSchema = z
  .object({
    format_version: z.literal(1),
    grants: z.array(
      z
        .object({
          tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).min(1),
          resources: z.array(capabilityResourceSchema).min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((capabilities, ctx) => {
    const selected = new Set<string>();
    capabilities.grants.forEach((grant, index) => {
      for (const name of grant.tools) {
        if (selected.has(name))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['grants', index, 'tools'],
            message: `Duplicate tool '${name}'.`,
          });
        selected.add(name);
      }
    });
  });

export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;
export type CapabilityResource = z.infer<typeof capabilityResourceSchema>;
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;
