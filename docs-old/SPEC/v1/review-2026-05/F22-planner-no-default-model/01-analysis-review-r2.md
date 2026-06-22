# F22 - Analysis Review r2

## Analysis

Approved. The r2 analysis removes the speculative first-cycle theory and states the only in-process conclusion the code supports: `loadEnvironment` synchronously parses and freezes config before server/runtime wiring, so a resolver failure cannot become a resolver success in the same process with the same parsed config. The root cause is now correctly framed as a boot-time validation gap rather than an ordering race or a missing sibling fallback.

The code anchors check out. `loadEnvironment` completes before `startServer`, `AgentRole` is only `planner | executor | reviewer | analyst`, `getModelListForRole` already has the `models.default` fallback, and the current schema accepts `models = {}` because the role keys are optional and the section defaults to an empty object. The r2 scope statement also resolves the 15-role discrepancy by choosing path b: F22 validates the four currently dispatched runtime roles, while schema widening, unknown-key rejection, and any operator-facing 15-role contract are explicitly out of scope.

## Design

Approved. The design now puts the fail-fast check at the right boundary: inside `loadEnvironment`, after schema validation and before returning the frozen `Environment`. That means `startApp` rejects before it awaits `startServer`, the existing degraded-runtime catch in `server.ts` is not involved, `/api/runtime/status` is never exposed for this precondition failure, and systemd sees the process fail instead of an API running without runtime.

The resolver disposition is also correct. The plan leaves the `getModelListForRole` throw message byte-identical and adds no invariant comment at the throw site, preserving the existing defense-in-depth behavior and its current test anchor. The `ValidateModelRolesResult` success shape includes `configuredRoles`, so the r1 type/test mismatch is gone.

## Plan

Approved. The implementation steps are consistent with the design: add `validate-model-roles` under `src/config`, export it through the config barrel, call it from `loadEnvironment` before `deepFreeze`, and avoid any changes to `ActiveRuntime.open` or the `server.ts` catch path. The unit cases cover direct roles, default fallback, empty arrays, routing/profile success and failure, and partial configuration.

The integration test requirement is now strong enough for the claimed behavior: it asserts `loadEnvironment` throws, `startApp` rejects with the same `EnvironmentLoadError`, `/api/runtime/status` is not bound in the broken case, and the positive-control config with `models.default` starts normally. The validation recipe uses existing package scripts, keeps the focused Jest tests named before the full sweep, and the LXC recipe is bounded with `journalctl -n ... --no-pager` and curl timeouts; there is no `tail -f` or `sleep 5` workflow.

VERDICT: APPROVED