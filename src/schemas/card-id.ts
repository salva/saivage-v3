import { z } from 'zod';

export const cardSegmentSchema = z.string().regex(/^[a-z]+$/u, 'Expected one or more lowercase ASCII letters.');
export const nonRootCardIdSchema = z.string().regex(/^card-[a-z]+(?:-[a-z]+){0,4}$/u, 'Expected a hierarchical card id with one to five alphabetic segments.');
export const cardIdSchema = z.union([z.literal('project'), nonRootCardIdSchema]);
export type CardId = z.infer<typeof cardIdSchema>;

export function nextCardSegment(segment?: string): string {
  if (segment === undefined) return 'a';
  cardSegmentSchema.parse(segment);
  const letters = [...segment];
  for (let index = letters.length - 1; index >= 0; index -= 1) {
    if (letters[index] !== 'z') {
      letters[index] = String.fromCharCode(letters[index]!.charCodeAt(0) + 1);
      return cardSegmentSchema.parse(letters.join(''));
    }
    letters[index] = 'a';
  }
  return cardSegmentSchema.parse(`a${letters.join('')}`);
}

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
