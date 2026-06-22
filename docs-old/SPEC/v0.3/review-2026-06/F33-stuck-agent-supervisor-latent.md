# F33: Stuck Agent Supervisor Is 560 Lines of Latent Feature

**Severity:** LOW  
**Transversality:** LOCAL  
**Category:** Over-engineering / Dormant feature  
**Verdict:** SOUND — confirmed at `src/runtime/stuck-agent-supervisor.ts`

## Summary

`StuckAgentSupervisor` (560 lines) has `DEFAULT_CHECK_PROVIDER` that always returns `stuck: false`, making it effectively dormant in production. The architecture supports stuck detection, but no real checker is wired.

## Corrected Evidence

- `src/runtime/stuck-agent-supervisor.ts:219-224` — Default check always returns "not stuck"
- `src/runtime/runtime.ts:115-122` — Production creates supervisor without setting a real provider
- `src/runtime/runtime-startup.ts:82-88` — Starts the dormant supervisor

## Clean Architecture Approach

Either wire a real stuck-check provider through runtime composition, or remove/disable the supervisor entirely until one exists. Do not start a no-op production supervisor that allocates timers and event listeners for nothing.