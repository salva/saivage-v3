# F07: actorKindFromId uses fragile prefix matching that will misclassify unknown IDs

## Summary

`actorKindFromId` (ids.ts:27-33) classifies actor IDs using `startsWith` checks, but the classification is incomplete and fragile. IDs starting with `planner:`, `reviewer:`, or `executor:` are classified as `'llm'`, but any future actor role prefix (e.g. `analyst:`) would fall through to the throw path. More critically, the `card:` prefix check on line 30 will match any string starting with `card:`, including hypothetical `card-log:` or `card-state:` IDs.

## Evidence

- `src/runtime/actors/ids.ts:27-33`:
  ```typescript
  export function actorKindFromId(actorId: string): ActorKind {
    if (actorId === supervisorActorId()) return 'supervisor';
    if (actorId.startsWith('card:')) return 'card';
    if (actorId.startsWith('planner:') || actorId.startsWith('reviewer:') || actorId.startsWith('executor:')) return 'llm';
    if (actorId.startsWith('process:')) return 'process';
    throw new Error(`Unknown actor id: ${actorId}`);
  }
  ```
- `ActorKind` type (line 1) is `'supervisor' | 'card' | 'llm' | 'process'` -- hardcoded to current roles, not extensible.

## Category

Bad assumption / short-sighted

## Severity

2 -- works for current IDs but will throw on any new actor role. Since actor IDs are constructed internally, this is not a security issue, but it is an abstraction violation: the ID scheme is coupled to the kind enum.

## Transversality

Cross-cutting (ids.ts, actor-recovery.ts, snapshots.ts, llm-runner.ts)