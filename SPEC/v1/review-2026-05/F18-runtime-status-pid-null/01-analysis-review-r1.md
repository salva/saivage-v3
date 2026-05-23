# F18 — Analysis Review (r1)

Bias: close to approved. The analysis and design choose the right architecture: remove `pid` from persisted `RuntimeState`, synthesize live `process.pid` at HTTP response boundaries, and make `saivage status` read the runtime lock holder instead of stale project state. I am requesting changes because the implementation plan's validation/deployment instructions would send the implementer down the wrong operational path.

## Findings

1. **Blocking: deployment instructions contradict the bind-mount workflow.** [03-plan-r1.md](03-plan-r1.md#L192-L214) says to stop the service, run `git fetch`, `git checkout`, `git pull --ff-only`, `npm ci`, and `npm run build` inside `10.0.3.170`, and then suggests `git pull` as an acceptable fallback. That is explicitly wrong for `saivage-v3-getrich-v2`: the deployment is bind-mounted, so the required flow is host-side `npm run build`, SSH `systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service`, then `curl -fsS http://10.0.3.170:8080/health`. Remove all in-container git/package/build steps and any copy/pull fallback language.

2. **Blocking: backend Jest commands omit the required ESM `NODE_OPTIONS`.** [03-plan-r1.md](03-plan-r1.md#L162-L171) and [03-plan-r1.md](03-plan-r1.md#L219-L223) use raw `npx jest ... --runInBand`, but the validation skill and [package.json](../../../../package.json#L14-L15) require `NODE_OPTIONS=--experimental-vm-modules` for backend Jest. Rewrite the targeted and touched-suite commands to include the env var, or use an npm script that supplies it. Including `--forceExit` would also match the validation skill.

3. **Required correction: the lock-file location is documented incorrectly.** [01-analysis-r1.md](01-analysis-r1.md#L82-L103), [02-design-r1.md](02-design-r1.md#L68-L75), and [02-design-r1.md](02-design-r1.md#L170-L200) repeatedly say the live holder lives in `.saivage/.lock`. The actual lock path in [src/runtime/lock.ts](../../../../src/runtime/lock.ts#L31-L35) is `.saivage-work/tmp/runtime/runtime.lock`. The `readLiveLockHolder` helper is justified, but the docs should say it reuses `lockPath(projectRoot)` rather than naming a non-existent `.saivage/.lock` surface.

## Confirmed Good

- The cited code paths match the finding: `/api/runtime/status` is assembled in [src/server/server.ts](../../../../src/server/server.ts#L64), `ActiveRuntime.getStatus()` returns no pid in [src/runtime/active-runtime.ts](../../../../src/runtime/active-runtime.ts#L197), and `/api/debug/state` currently returns raw persisted state in [src/server/routes/chats-files-debug.ts](../../../../src/server/routes/chats-files-debug.ts#L307-L330).
- Removing `pid` from persisted `RuntimeState` is the right architecture-first fix. [runtimeStateSchema](../../../../src/schemas/validators.ts#L115) is a normal `z.object(...)` with no `.strict()`, and [src/runtime/state.ts](../../../../src/runtime/state.ts#L12) uses it directly for persistence, so old on-disk files with an extra `pid` key will parse and strip cleanly without a compatibility shim.
- The planned route-boundary overlays are correct: `/api/runtime/status` should add `pid: process.pid` in both active and fallback branches, and `/api/debug/state` should return `state ? { ...state, pid: process.pid } : null` so the Debug UI gets live truth without storing pid.
- The proposed coverage is directionally right: tests cover `/api/runtime/status`, stale-on-disk stripping, and `/api/debug/state` overlay. After fixing the command prefix, those should be Jest tests, not Vitest.

VERDICT: CHANGES_REQUESTED