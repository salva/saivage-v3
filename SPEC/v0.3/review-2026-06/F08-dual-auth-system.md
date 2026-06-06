# F08: Dual Auth System (Fastify Plugin + Contract Runtime)

**Severity:** MEDIUM  
**Transversality:** ARCHITECTURAL  
**Category:** Tangled code  
**Verdict:** SOUND — confirmed at `src/server/auth.ts:47-83` and `src/server/contract-runtime.ts:101-139`

## Summary

Auth is enforced twice: once by `auth.ts` via a Fastify `onRoute` hook that adds `authenticate()` as `preHandler` on all `/api` routes, and again by `contract-runtime.ts` via `validateAuth()` inside each contract handler. Every protected API request runs two auth checks. The plugin also uses manual preHandler chaining that bypasses Fastify's normal hook lifecycle.

## Corrected Evidence

- `src/server/auth.ts:47-83` — Plugin-level preHandler auth hook for all `/api` routes
- `src/server/contract-runtime.ts:133-139` — Per-contract auth validation via `getAuthPolicy().validateHttpRequest()`
- `src/server/auth.ts:60-81` — Manual `existingPreHandler` chaining, sends response directly instead of using Fastify error lifecycle

## Clean Architecture Approach

Make `ContractRuntime` the single auth/permission authority for contract routes. Remove the broad Fastify `/api` preHandler hook. Public routes use `auth: 'public'` in their contract definition, protected routes get auth checked once in `mountOne`. This eliminates the bypassing pattern in `auth.ts` as well.