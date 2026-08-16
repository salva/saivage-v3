import { z } from 'zod';

export const cardTypeNameSchema = z.string().regex(
  /^[a-z][a-z0-9-]{0,63}$/u,
  'Expected a lowercase card-type name of at most 64 ASCII letters, digits, or hyphens.',
);
export type CardTypeName = z.infer<typeof cardTypeNameSchema>;

export function parseCardTypeName(value: unknown): CardTypeName {
  return cardTypeNameSchema.parse(value);
}
