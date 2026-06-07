# Impossible-State Cleanup Metaplan

Date: 2026-06-07

Source inventory: `docs/design/impossible-state-support-review.md`.

This metaplan converts the reconciled impossible-state support review into an implementation plan. It follows the project rules in `AGENTS.md`: simple and clean architecture, no backward compatibility, fail fast for impossible states, no over-defensive code, brave refactoring, and aggressive dead-code removal.

## Goal

Normal runtime code must not recover from, normalize, synthesize, or silently continue through states that are impossible under correct Saivage v3 operation. If a normal path reaches such a state, it should throw a specific invariant/protocol error or enter an explicit operator-visible failed/frozen runtime state. Repair code may exist only in narrow startup/recovery modules and must not contradict authoritative card/runtime truth.

## Non-Goals

- No compatibility shims for old planner sessions, old invocation overloads, or old activation edge shapes.
- No degraded-mode replacement paths for internal runtime corruption.
- No migration layer for existing bad runtime state. If bad state is encountered, fail loudly and reset/repair explicitly.
- No broad repair hidden inside normal ticks, terminal commits, message construction, or tool execution.

## Waves

1. [Wave 1: Runtime State Foundation](wave-01-runtime-state-foundation.md)
2. [Wave 2: Activation And Reviewer Ownership](wave-02-activation-reviewer-ownership.md)
3. [Wave 3: Terminal Transitions And Executor Truth](wave-03-terminal-transitions-executor-truth.md)
4. [Wave 4: Identity And Compatibility Deletion](wave-04-identity-compatibility-deletion.md)
5. [Wave 5: Agent Session And Protocol Strictness](wave-05-agent-session-protocol-strictness.md)
6. [Wave 6: Startup Repair Narrowing](wave-06-startup-repair-narrowing.md)
7. [Wave 7: Runtime State Semantic Cleanup](wave-07-runtime-state-semantic-cleanup.md)

## Dependency Order

Wave 1 is foundational. It removes live repair from the tick loop and makes runtime state failures visible. Later waves should not begin until Wave 1 makes impossible runtime-state combinations fail rather than self-heal.

Wave 2 depends on Wave 1 because activation/reviewer ownership failures must surface through strict runtime state handling.

Wave 3 depends on Waves 1 and 2 because terminal transition failure and executor completion need strict active-run and activation ownership semantics.

Wave 4 can run after Wave 2 because activation/session identity must be explicit before compatibility lookup and overload removal is safe.

Wave 5 can run after Wave 4 because session/protocol strictness should use the simplified invocation and identity API.

Wave 6 should run after Waves 1-3 so startup repair can use the final normal-path invariants.

Wave 7 should run last because it changes the semantic contract of `active_card_run` and should be based on the cleaned-up runtime run ledger.

## Cross-Cutting Architecture Rules

### Rule A: Separate Normal Runtime From Repair

Normal runtime code should never call repair-oriented helpers. Repair functions should live under explicitly named startup/recovery modules and accept explicit repair context.

Accepted repair locations:
- `src/runtime/startup-*.ts`
- `src/runtime/activation-repair.ts`
- narrowly-scoped recovery modules that are invoked only during startup or explicit operator repair actions

Rejected repair locations:
- normal `tick()`
- normal phase handlers
- terminal commit helpers
- runtime mutation application
- agent/session message construction

### Rule B: No Synthesized Identity

Do not synthesize `planner:${cardId}`, caller tool ids, empty goal/card ids, or placeholder assessment ids in paths that should already know these values. Identity must come from the card, runtime activation ledger, runtime run ledger, or structured invocation request.

### Rule C: Errors Should Be Typed And Operator-Visible

Use specific error classes for runtime invariants, protocol violations, and corrupted persisted state. Do not throw anonymous strings or generic messages when the error affects runtime control flow.

Recommended classes:
- `RuntimeStateInvariantError`
- `RuntimeActivationInvariantError`
- `RuntimeDispatchInvariantError`
- `AgentProtocolError`
- `SessionInvariantError`

### Rule D: External Protocol Failures Are Not Internal State, But Must Not Be Normalized

Malformed model/provider output is external input. It does not require process-wide crash by default. It must still preserve evidence and must not execute tools with fabricated empty args. Convert it to a protocol/verifier failure and let the agent repair or abort according to the contract.

### Rule E: Validation Must Prove Failure, Not Just Success

Every wave needs tests that assert impossible states throw. Passing happy-path tests are not sufficient.

## Global Validation Matrix

Each wave should run focused tests for touched modules and at minimum:

```bash
npm run typecheck
npm test
npm run validate:docs
```

After runtime or agent execution changes, also run:

```bash
npm run validate:routine
npm run build
```

For deployment-impacting runtime changes, rebuild and restart the GetRich v2 deployment, then probe:

```bash
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
curl -fsS http://10.0.3.170:8080/health/ready
```

## Commit Strategy

Commit after each wave. Do not batch all waves into one commit. If a wave is large, split into coherent commits that each remove one category of impossible-state support and pass focused validation.

Suggested commit messages:
- `fix(runtime): fail fast on impossible runtime state`
- `fix(runtime): require activation ownership for child unwind`
- `fix(runtime): fail terminal commits on rejected transitions`
- `refactor(agents): remove compatibility invocation overloads`
- `fix(agents): reject malformed protocol args without normalization`
- `fix(runtime): narrow startup repair invariants`
- `refactor(runtime): make active card run current-only`

## Risk Controls

- Prefer deleting fallback branches over adding flags.
- Prefer explicit structured inputs over optional fields plus defaulting.
- Prefer throwing before mutation over repairing after mutation.
- Keep repair behavior isolated and named.
- Do not preserve old behavior for existing bad persisted state; fail and reset/repair explicitly.

## Completion Criteria

The cleanup is complete when:

- Normal tick no longer patches runtime state.
- Activation completion cannot silently no-op.
- Reviewer child completion distinguishes activation-owned from direct dispatch.
- Terminal commit paths throw on missing/illegal card transitions.
- Active-run construction no longer synthesizes identity fields.
- Agent invocation APIs no longer accept old string overloads or empty identifiers.
- Session message stamping is owned by one authoritative stamper.
- Malformed model/tool arguments are preserved as protocol failures, not normalized to `{}`.
- Startup repair is narrow and fails on contradictory state.
- `active_card_run` has one clear semantic meaning.
