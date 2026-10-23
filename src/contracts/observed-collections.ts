import { z } from 'zod';

export const listObservedCollectionsInputSchema = z.object({}).strict();
export const queryObservedCollectionsInputSchema = z
  .object({
    collections: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/))
      .min(1)
      .max(8)
      .refine((names) => new Set(names).size === names.length),
    query: z
      .string()
      .min(1)
      .refine((s) => Buffer.byteLength(s) <= 4096),
    intent: z.enum(['balanced', 'conceptual', 'identifier']).default('balanced'),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type ObservedQuery = z.infer<typeof queryObservedCollectionsInputSchema>;
export type ObservedChannel = 'lexical' | 'neural';
interface ObservedCollectionStatus {
  name: string;
  purpose: string;
  kind: 'documentation' | 'code';
  queryability: 'available' | 'initializing' | 'unavailable';
  coverage: 'incomplete' | 'unknown';
  limitations: string[];
}
export interface ObservedHit {
  rank: number;
  memberships: { collection: string; path: string }[];
  excerpt: string;
  excerpt_truncated: boolean;
  transformed: boolean;
  location: 'unavailable';
  channels: ObservedChannel[];
}
export interface ObservedResult {
  collections: ObservedCollectionStatus[];
  hits: ObservedHit[];
  coverage: {
    exhaustive: false;
    failed_channels: ObservedChannel[];
    unavailable_channels: ObservedChannel[];
    candidate_limit_reached: boolean;
    postfilter_removals: boolean;
    output_truncated: boolean;
    limitations: string[];
  };
}
/** The binder supplies its existing ordinary reader authority, not native credentials. */
export interface RetrievalCaller {
  resolveReadablePath(path: string): string;
}
export interface RetrievalPort {
  list(caller: RetrievalCaller, signal: AbortSignal): Promise<ObservedResult>;
  query(
    input: ObservedQuery,
    caller: RetrievalCaller,
    signal: AbortSignal,
  ): Promise<ObservedResult>;
}
