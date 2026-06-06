# F09: Web Imports Backend Source Internals via ../../../src/ Paths

**Severity:** HIGH  
**Transversality:** ARCHITECTURAL  
**Category:** Bad abstraction boundary  
**Verdict:** SOUND — confirmed at `web/src/api/contracts.ts:1-149`

## Summary

The web frontend imports directly from backend source via `../../../src/contracts/*` and `../../../src/schemas/*`. This is a hard architecture boundary violation: the web package cannot build independently from the server source tree, and any server refactor of contract paths silently breaks the web build.

## Corrected Evidence

- `web/src/api/contracts.ts:1-14` — Direct imports from `../../../src/contracts/operator-api`
- `web/src/api/types.ts:1-37` — Type aliases from re-exported backend types
- `web/src/stores/debug-read-model.ts:5` — Another direct backend import
- `web/src/api/types.ts:111-131,167-219` — Local type overrides that can silently diverge from server contracts

## Clean Architecture Approach

Create a first-class shared/generated contract package (e.g., `@saivage/contracts`) consumed by both server and web. The web imports from the package, never from `../../../src/`. Type aliases that add no transformation should be removed; use the contract types directly.