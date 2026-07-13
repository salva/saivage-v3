import {
  assertIssuedAuthority,
  issueCompositionMutationAuthority,
  isAuthorityCurrent,
  mcpInvocationCallerKind,
  type CompositionMutationAuthority,
  type McpInvocationAuthority,
  type MutationAuthority,
} from './mutation-authority.js';

export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;
export type McpInvocationAdmission = 'none' | 'analyst' | 'autonomous';

export interface MutationLane {
  apply<T>(authority: MutationAuthority, label: string, mutation: () => NotPromise<T>):
    | { readonly applied: true; readonly value: T }
    | { readonly applied: false; readonly reason: 'stale' };
  deliverMcpToolResult<T>(authority: McpInvocationAuthority, label: string, mutation: () => NotPromise<T>):
    | { readonly kind: 'delivered'; readonly value: T }
    | { readonly kind: 'stale_delivery' };
}

export interface MutationLaneComposition {
  readonly lane: MutationLane;
  readonly authority: CompositionMutationAuthority;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

export function createMutationLane(readMcpAdmission: () => McpInvocationAdmission = () => 'none'): MutationLaneComposition {
  let applying = false;

  function run<T>(mutation: () => NotPromise<T>): T {
    if (applying) throw new Error('Recursive MutationLane submission is forbidden.');
    applying = true;
    try {
      const value = mutation();
      if (isThenable(value)) throw new Error('MutationLane callbacks must be synchronous.');
      return value as T;
    } finally {
      applying = false;
    }
  }

  const lane: MutationLane = Object.freeze({
    apply<T>(authority: MutationAuthority, _label: string, mutation: () => NotPromise<T>) {
      assertIssuedAuthority(authority);
      if (!isAuthorityCurrent(authority)) return { applied: false as const, reason: 'stale' as const };
      return { applied: true as const, value: run(mutation) };
    },
    deliverMcpToolResult<T>(authority: McpInvocationAuthority, _label: string, mutation: () => NotPromise<T>) {
      const callerKind = mcpInvocationCallerKind(authority);
      if (readMcpAdmission() !== callerKind || !isAuthorityCurrent(authority)) return { kind: 'stale_delivery' as const };
      return { kind: 'delivered' as const, value: run(mutation) };
    },
  });

  return Object.freeze({ lane, authority: issueCompositionMutationAuthority() });
}
