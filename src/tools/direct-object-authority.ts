import { cardParentId, type CapabilityScope } from '../schemas/index.js';
import type { CompiledToolReference } from './runtime-tool-catalog.js';
import { ToolArgumentValidationError } from './invocation.js';

/** Harness-owned activation anchor and selected compiled tools; never model input. */
export interface DirectObjectAuthority {
  readonly anchorCardId: string | null;
  readonly tools: readonly CompiledToolReference[];
}
type DirectObjectTarget =
  | { readonly kind: 'workspace' }
  | { readonly kind: 'card'; readonly cardId: string }
  | { readonly kind: 'record'; readonly cardId: string; readonly name: string };

function relationshipMatches(
  scopes: readonly CapabilityScope[],
  anchor: string | null,
  reachedId: string,
): boolean {
  if (scopes.includes('all')) return true;
  if (anchor === null) return false;
  if (scopes.includes('self') && anchor === reachedId) return true;
  let parent = cardParentId(reachedId);
  if (scopes.includes('children') && parent === anchor) return true;
  if (scopes.includes('descendants')) {
    while (parent !== null) {
      if (parent === anchor) return true;
      parent = cardParentId(parent);
    }
  }
  return false;
}

/** Call only with an object just reached by the operation's canonical owning read. */
export function allowsReachedObject(
  authority: DirectObjectAuthority,
  tool: string,
  target: DirectObjectTarget,
): boolean {
  return (
    authority.tools
      .find(({ name }) => name === tool)
      ?.resources.some((clause) => {
        if (target.kind === 'workspace') return clause.kind === 'workspace';
        if (clause.kind === 'workspace' || clause.kind !== target.kind) return false;
        if (!relationshipMatches(clause.scopes, authority.anchorCardId, target.cardId))
          return false;
        return (
          clause.kind === 'card' ||
          (target.kind === 'record' &&
            clause.patterns.some(({ matcher }) => matcher.test(target.name)))
        );
      }) ?? false
  );
}

export function assertReachedObjectAuthority(
  authority: DirectObjectAuthority,
  tool: string,
  target: DirectObjectTarget,
): void {
  if (!allowsReachedObject(authority, tool, target))
    throw new ToolArgumentValidationError(
      `Tool '${tool}' is not authorized for '${target.kind === 'workspace' ? 'workspace' : `${target.cardId}${target.kind === 'record' ? `/${target.name}` : ''}`}'.`,
    );
}
