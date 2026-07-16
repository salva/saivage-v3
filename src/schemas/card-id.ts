import { z } from 'zod';

export const canonicalUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, 'Expected a canonical lowercase UUID.');
export const cardIdSchema = z.union([z.literal('project'), canonicalUuidSchema]);
export const nonRootCardIdSchema = canonicalUuidSchema;
