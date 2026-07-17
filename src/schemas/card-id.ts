import { z } from 'zod';

export const canonicalUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, 'Expected a canonical lowercase UUID.');
export const cardSegmentSchema = z.string().regex(/^[a-z]{28}$/u, 'Expected 28 lowercase ASCII letters.');
export const nonRootCardIdSchema = z.string().regex(/^card-[a-z]{28}(?:-[a-z]{28}){0,4}$/u, 'Expected a hierarchical card id with one to five opaque segments.');
export const cardIdSchema = z.union([z.literal('project'), nonRootCardIdSchema]);
export type CardId = z.infer<typeof cardIdSchema>;

export type CardSegmentFactory = () => string;

export function cardIdSegments(id: string): string[] {
  cardIdSchema.parse(id);
  return id === 'project' ? [] : id.slice('card-'.length).split('-');
}

export function cardDepth(id: string): number { return cardIdSegments(id).length; }

export function cardParentId(id: string): string | null {
  const segments = cardIdSegments(id);
  if (segments.length === 0) return null;
  if (segments.length === 1) return 'project';
  return `card-${segments.slice(0, -1).join('-')}`;
}

export function childCardId(parentId: string, segment: string): string {
  cardIdSchema.parse(parentId);
  cardSegmentSchema.parse(segment);
  const id = parentId === 'project' ? `card-${segment}` : `${parentId}-${segment}`;
  return nonRootCardIdSchema.parse(id);
}
