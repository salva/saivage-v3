# LLM Gateway Review — Phase E Metaplan (r2)

Scope: ordered, commit-by-commit execution plan unifying the six APPROVED issue plans (F03–F08) for the LLM gateway subsystem. Self-contained. File references are workspace-relative to `/home/salva/g/ml/saivage-v3/` and clickable. Architecture-first: no backward-compat shims, no migration aliases, no minimal-change defaults. Each batch is one git commit and ends green.

Revision history:
- r1 (superseded): [99-METAPLAN.md](99-METAPLAN.md).
- r1 reviewer critique: [99-METAPLAN-review-r1.md](99-METAPLAN-review-r1.md) — VERDICT: CHANGES_REQUESTED on F05/F08 contract-mismatch ownership.
- r2 (this file): F05 B1 and B2 rewritten so terminal-protocol / contract errors construct typed `LlmFailure { kind: 'contract_mismatch', ... }` **values** at the gateway boundary and the recovery policy keeps the F08 switch-based branch. No new exception classes are added; no `instanceof` branch is added to `InvocationRecoveryPolicy.decideFailure`. F08 remains the foundational typed-failure layer (M02); F05 B1/B2 remain at M04/M05. Ordering, validation gates, and risk register otherwise unchanged.

Anchors:
- F03: [F03-cooldown-policy-and-persistence/COMBINED-r2.md](F03-cooldown-policy-and-persistence/COMBINED-r2.md)
- F04: [F04-observability-event-gaps/COMBINED-r3.md](F04-observability-event-gaps/COMBINED-r3.md)
- F05: [F05-envelope-vs-toolcalls-orthogonality/03-plan-r7.md](F05-envelope-vs-toolcalls-orthogonality/03-plan-r7.md) (B1–B6 anchor)
- F06: [F06-tool-definition-typed-serializer/COMBINED-r3.md](F06-tool-definition-typed-serializer/COMBINED-r3.md)
- F07: [F07-fallback-chain-duplication/COMBINED-r2.md](F07-fallback-chain-duplication/COMBINED-r2.md)
- F08: [F08-failure-classification-fragile/COMBINED-r2.md](F08-failure-classification-fragile/COMBINED-r2.md)
- Subsystem map: [00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md)

---

## 1. Importance × Transversality (1–5)

| Issue | Importance | Transversality | Rationale (one line) |
| --- | ---: | ---: | --- |
| F05 envelope-orthogonality | 5 | 5 | Touches every envelope-bearing role + both gateways + persistence + recorder + schemas + web; the contract flip. |
| F08 typed `LlmFailure` | 5 | 4 | Replaces the only typed surface between transport errors and recovery; preconditions F03, F04 payloads, and F05's contract-mismatch reporting. |
| F03 cooldown + persistence | 4 | 3 | Replaces in-memory health with cross-restart `CandidateAvailability`; depends on F08 typed failure carrying `retryAfterMs`/`resetsAt`. |
| F04 observability | 4 | 3 | Collapses four agent-domain events into `llm_attempt` + `llm_invocation_summary`; consumes F08 `failure.kind` and F05 `terminal_tool`. |
| F07 fallback-chain dedup | 3 | 2 | Schema-only enforcement + dead-shim removal + one analyst-writer rename; quarantined to config layer. |
| F06 tool-definition serializer | 2 | 2 | Micro-edit: one new module + two gateway swap-ins; disjoint from F05 message-serialization scope. |

## 2. Sequencing constraints (from the approved plans)

1. **F08 → F03**: F03's `AvailabilityDecision` reads `failure.retryAfterMs` / `failure.resetsAt` directly; the typed union must exist first (F03 §2.5, F08 §3.2).
2. **F08 → F04**: F04's `llm_attempt.outcome[failed]` carries `failure_class` and `error_name`/`error_message` taken straight from the typed `LlmFailure` (F04 §2.2 emission block).
3. **F08 → F05** (new, per r2 reconciliation): F05 B1's terminal-protocol validator and B2's persistence-shape guard raise `LlmRequestError(LlmFailure { kind: 'contract_mismatch', subtype })` — they depend on the typed union and the `ContractMismatchSubtype` enum declared in `src/agents/llm-failure.ts` at M02.
4. **F05 → F04**: F04 `llm_attempt.outcome[succeeded].terminal_tool` and `llm_invocation_summary.final_terminal_tool` consume the F05 contract (F04 §2.4).
5. **F05 B1..B6 anchor order is preserved**: B1 substrate → B2 contract flip + all consumers → B3 delete result-parser family → B4 capability axes → B5 web migration → B6 sweep + live probe (F05 §3).
6. **F06 is adjacent to F05's gateway-touching batches but disjoint in scope**: F06 only touches `src/agents/llm-openai-chat-gateway.ts`, `src/agents/llm-openai-codex-gateway.ts`, plus the new `src/agents/tool-definition-serializer.ts`. F05-B2 already rewrites the gateways' wire shape; the cleanest insertion is **immediately after F05-B2** so the serializer swap-in lands on the already-clean gateway bodies.
7. **F07 is independent and low-risk**: it only touches `src/agents/config-schema.ts`, `src/agents/model-router.ts`, `src/agents/analyst-config-writer.ts`, and the live `saivage.json`. Place it FIRST as a warmup so every subsequent live probe runs against the corrected config shape.

## 3. Ordered metaplan (commit-by-commit)

```
M01  F07 single-batch          (config + router + analyst-writer + live config migration)
M02  F08 transactional B1      (typed LlmFailure substrate + classifiers + every importer rewrite)
M03  F03 transactional batch   (CandidateAvailability + delete ProviderRegistry health + rewire)
M04  F05 B1                    (additive substrate: role-envelope-schemas, zod-to-jsonschema-mini, terminal-protocol, persisted-tool-call)
M05  F05 B2                    (contract flip + all consumers + persistence + recorder + schemas + fixtures)
M06  F06 single-batch          (tool-definition-serializer + chat & codex gateway swap-ins)
M07  F05 B3                    (delete result-parser.ts family)
M08  F05 B4                    (capability axes: toolsMode + exclusiveToolChoiceSupport)
M09  F05 B5                    (web migration: presenters, stores, viewer, event-log badge)
M10  F05 B6                    (sweep script + probe-llm-contract live playbook)
M11  F04 single-batch          (llm_attempt + llm_invocation_summary; delete four legacy event kinds)
```

Total batches: **11**. Each is one commit; each ends with green `npx tsc --noEmit` plus the targeted Jest (and Vitest where applicable) runs listed in the batch.

---

## 4. Per-batch detail

Validation convention used throughout (anchored on F05 §0): root project is Jest, web is Vitest. Specific files are run via `npm test -- --runTestsByPath <abs/relative paths>` (root) and `cd web && npx vitest run <web-relative path>` (web). Full root suite is `npm test`; full web suite is `cd web && npm test`. Typecheck is `npx tsc --noEmit` (root) and `cd web && npx tsc --noEmit` (web).

Deploy convention (see §5 below): `npm run build` → `rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3/dist/` → `ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'` → `curl -fsS http://10.0.3.170:8080/health`.

Rollback convention: every batch is a single commit. `git revert <sha>` undoes the batch; for batches that touched the live config or the running service, redeploy the immediately prior `dist/` artifact via `rsync` and `systemctl restart saivage-v3-getrich.service`, then re-run health.

---

### M01 — F07: single source of truth + dead-shim removal + analyst-writer correctness

Source: [F07/COMBINED-r2.md §3.1–§3.5](F07-fallback-chain-duplication/COMBINED-r2.md).

Files touched:
- [src/agents/config-schema.ts](../../../src/agents/config-schema.ts) — `MODELS_RESERVED_KEYS` += `'default'`; `default: z.array(z.string()).min(1).optional()` on `modelsSectionSchema`; `.superRefine` rejects role array byte-equal to `models.default` and rejects empty per-role arrays; root schema `.strict()`; delete root `failover: …`; emit migration message naming `models.failover`.
- [src/agents/model-router.ts](../../../src/agents/model-router.ts) — delete `topFailover` block at L60–L63 and its consumer at L92.
- [src/agents/analyst-config-writer.ts](../../../src/agents/analyst-config-writer.ts) — rename `setFailoverOrder(role, ...)` → `setFailoverChain(forModel, orderedFailoverModels)`; write `models.failover[forModel]`; update every call site (`grep -rn "setFailoverOrder" src/ web/`).

Tests to add/update:
- [tests/agents/config-schema.test.ts](../../../tests/agents/config-schema.test.ts) — delete the existing "should include failover from top-level key" test at L252–L266; add `rejects top-level failover with migration message`, `rejects role array byte-equal to models.default`, `accepts role array that differs`, `accepts role inheriting default`, `rejects models.default of length 0`, `rejects empty per-role override array`.
- [tests/agents/model-router.test.ts](../../../tests/agents/model-router.test.ts) — add `top-level failover is no longer honoured by the router`.
- [tests/agents/analyst-config-writer.test.ts](../../../tests/agents/analyst-config-writer.test.ts) (create if absent) — `setFailoverChain writes only to models.failover and never to root`; round-trip through `loadConfig`.

Validation:
- `npx tsc --noEmit`
- `npm test -- --runTestsByPath tests/agents/config-schema.test.ts tests/agents/model-router.test.ts tests/agents/analyst-config-writer.test.ts`
- `npm test`

Live probe (per F07 §3.4–§3.5):
- Run the on-host Python migration script described in F07 §3.4 against `/work/getrich-v2/.saivage/saivage.json` (removes 12 redundant role arrays; defensively migrates a root `failover` if present).
- Deploy per §5; `curl -fsS http://10.0.3.170:8080/health` ⇒ 200; `journalctl -u saivage-v3-getrich.service --since "1 minute ago" | grep -iE "models\.|failover|error|fatal"` ⇒ no schema rejections.

Rollback: `git revert <sha>`; redeploy prior `dist/`; the migration script keeps no on-disk backup (per the architecture-first guideline) — re-add `chat`/`analyst` overrides by hand from the chain values quoted in F07 §3.6 if needed.

Commit message: `F07: enforce single source of truth for model chains; delete top-level failover shim; rename setFailoverOrder → setFailoverChain`.

---

### M02 — F08 transactional B1: typed `LlmFailure` substrate + every importer rewrite

Source: [F08/COMBINED-r2.md §3.1](F08-failure-classification-fragile/COMBINED-r2.md).

Files created:
- [src/agents/llm-failure.ts](../../../src/agents/llm-failure.ts) — `LlmFailure` discriminated union (`auth_permanent`, `rate_limit`, `server_transient`, `timeout`, `contract_mismatch`, `capability_mismatch`, `token_budget_exceeded`, `parse_error`, `cancelled`, `unknown`); `ContractMismatchSubtype` (includes at minimum: `terminal_tool_missing`, `terminal_tool_unexpected`, `tool_arguments_invalid_json`, `tool_arguments_schema_violation`, `legacy_message_shape`, `unknown`); `LlmRequestError`; `unwrapFailure`.
- [src/agents/llm-failure-classifiers.ts](../../../src/agents/llm-failure-classifiers.ts) — per-provider `ProviderFailureClassifier` table for `opencode`, `opencode-go`, `openai-chat`, `openai-codex`, `github-copilot`, `nvidia-nim`; `defaultHttpClassifier`; `classifierFor`.

Files modified (all in the same commit to keep the tree compilable):
- [src/agents/llm-errors.ts](../../../src/agents/llm-errors.ts) — delete `LlmAuthError`, `LlmRateLimitError`, `LlmServerError`, `LlmTimeoutError`, `LlmParseError`, `StructuredLlmError`, `isStructuredLlmError`, `handleLlmHttpError`, `normalizeLlmTransportError`; keep `redactProviderErrorText`; re-export `LlmRequestError`/`LlmFailure`.
- [src/agents/llm-openai-chat-gateway.ts](../../../src/agents/llm-openai-chat-gateway.ts), [src/agents/llm-openai-codex-gateway.ts](../../../src/agents/llm-openai-codex-gateway.ts) — replace `!response.ok` branches and stream/transport catches with `classifierFor(provider).classifyHttp/Transport(...) ?? defaultHttpClassifier(...)` + `throw new LlmRequestError(failure)`.
- [src/agents/llm-provider-gateway.ts](../../../src/agents/llm-provider-gateway.ts) — capability-mismatch throw becomes `LlmRequestError({ kind: 'capability_mismatch', ... })`.
- [src/agents/llm-stream-parser.ts](../../../src/agents/llm-stream-parser.ts), [src/agents/llm-codex-parser.ts](../../../src/agents/llm-codex-parser.ts) — every throw site emits `LlmRequestError` with the correct `kind`.
- [src/agents/llm-recording.ts](../../../src/agents/llm-recording.ts) — status extraction via `err instanceof LlmRequestError && 'status' in err.failure ? err.failure.status : undefined`.
- [src/agents/analyst-llm-resolver.ts](../../../src/agents/analyst-llm-resolver.ts) — `catch` block rewritten per F08 §3.1.2 #10 to dispatch on `unwrapFailure(err).kind`.
- [src/agents/invocation-recovery-policy.ts](../../../src/agents/invocation-recovery-policy.ts) — delete `InvocationFailureClass`, `isAbortLike`, `isCapabilityMismatch`; `classify = unwrapFailure`; `decideFailure = switch (failure.kind)` with `assertNever` covering every `LlmFailure.kind` including `'contract_mismatch'`; `InvocationRecoveryDecision.failureClass` → `failure: LlmFailure | undefined`. The `case 'contract_mismatch':` branch is fully owned here (it is M05's behavioural contract — see M05 below — but the switch arm itself is added now so the union exhaustiveness check passes at M02).
- [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) — `decision.failureClass` → `decision.failure?.kind`; event payloads emit `failure: decision.failure`.

Tests to add/update:
- [tests/agents/llm-failure-classifiers.test.ts](../../../tests/agents/llm-failure-classifiers.test.ts) (new) — fixtures per F08 §3.3 #1 (opencode-go HTTP 400 contract, openai-chat 429 with `Retry-After`, openai-codex 429 with ISO `x-ratelimit-reset`, deepseek 400 `context_length_exceeded`, default-mapper fallthrough).
- [tests/agents/invocation-recovery-policy.test.ts](../../../tests/agents/invocation-recovery-policy.test.ts) — rewrite every fixture to assert `decision.failure?.kind` and `decision.action`; include a `case 'contract_mismatch'` placeholder test that asserts the switch arm exists and returns a non-undefined decision (the behavioural assertion — `fail_invocation` + `appendModelIssue: true` + `abort: true` — lands in M05).
- [tests/agents/agent-adapter-recovery.test.ts](../../../tests/agents/agent-adapter-recovery.test.ts) — replace `new LlmAuthError(...)` / `new LlmServerError(...)` with `new LlmRequestError({ kind: ..., status: ..., provider: ..., message: ... })`.

Validation:
- `npx tsc --noEmit`
- `npm test -- --runTestsByPath tests/agents/llm-failure-classifiers.test.ts tests/agents/invocation-recovery-policy.test.ts tests/agents/agent-adapter-recovery.test.ts`
- `npm test`
- Grep gates (must all be empty):
  - `grep -rn 'LlmAuthError\|LlmRateLimitError\|LlmServerError\|LlmTimeoutError\|LlmParseError\|StructuredLlmError\|handleLlmHttpError\|normalizeLlmTransportError\|InvocationFailureClass\|failureClass\b' src/ tests/ web/src/`
  - `grep -rn "'server_transient'\|'rate_limit_transient'\|'timeout_transient'\|'parse_or_contract'" src/ tests/ web/src/`

Live probe: deploy per §5; `curl -fsS http://10.0.3.170:8080/health` ⇒ 200; `journalctl -u saivage-v3-getrich.service -n 200 --no-pager | grep -i 'LlmRequestError\|failure.kind'` returns the new typed shape.

Rollback: `git revert <sha>` (atomic single commit); redeploy prior `dist/`; legacy error classes return.

Commit message: `F08: typed LlmFailure substrate + per-provider classifiers; delete eight-member string union and legacy error hierarchy`.

---

### M03 — F03: `CandidateAvailability` substrate + delete `ProviderRegistry` health + rewire

Source: [F03/COMBINED-r2.md §3 Batch 2](F03-cooldown-policy-and-persistence/COMBINED-r2.md) (Batch 1 of F03 r2 is subsumed by F08 — the typed `LlmFailure` already carries `retryAfterMs`/`resetsAt`, so the "extend `LlmRateLimitError`" step is moot).

Files created:
- [src/agents/candidate-availability.ts](../../../src/agents/candidate-availability.ts) — `CandidateState`, `CandidateAvailabilityEntry`, `CandidateAvailability` interface, in-memory implementation with monotonic-`untilMs` invariant per F03 §2.2.
- [src/agents/candidate-availability-store.ts](../../../src/agents/candidate-availability-store.ts) — `FsCandidateAvailability` (JSONL append-only writer at `.saivage/runtime/candidate-availability.jsonl`, advisory `flock(LOCK_EX | LOCK_NB)` on `.saivage/runtime/candidate-availability.lock`, replay reader, compaction at `runtime.candidateAvailabilityCompactBytes`); `MemoryCandidateAvailabilityStore` for tests.

Files modified:
- [src/agents/provider.ts](../../../src/agents/provider.ts) — DELETE `healthStates`, `getHealth`, `isHealthy`, `markFailed`, `markSucceeded`, `markAttempted`, `getAllHealth`, `resetHealth`, `getCooldownMs`, `CandidateHealth`, `defaultHealth`. Keep `candidateKey` / `parseCandidateKey`.
- [src/agents/invocation-recovery-policy.ts](../../../src/agents/invocation-recovery-policy.ts) — REPLACE `cooldownMs?: number` on `InvocationRecoveryDecision` with `availability?: AvailabilityDecision`. Construct decisions per F03 §2.2 from `failure.retryAfterMs ?? failure.resetsAt`; **no `maxCooldownMs` cap**. Sign-check guard (`untilMs > Date.now()`).
- [src/agents/model-router.ts](../../../src/agents/model-router.ts) — constructor adds `availability: CandidateAvailability`; eligibility callback uses `availability.isAvailable(c)`.
- [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) — constructor adds `candidateAvailability: CandidateAvailability`; `markSucceeded`/`markFailed` sites at L301/L317/L322/L397/L398/L406 flip to `availability.markSucceeded(candidate)` / `if (decision.markFailed && decision.availability) await availability.markFailed(candidate, decision.availability)`; pass the same instance into the inner `ModelRouter`.
- [src/agents/analyst-llm-resolver.ts](../../../src/agents/analyst-llm-resolver.ts) — constructor becomes `(projectRoot, availability: CandidateAvailability)`; delete the ad-hoc `registry.markFailed`/`registry.markSucceeded` calls at L174–L182; route through `defaultInvocationRecoveryPolicy.decideFailure(err, ctx)` + `availability.markFailed(c, decision.availability)`.
- [src/agents/analyst-handler.ts](../../../src/agents/analyst-handler.ts) — `new LlmIntentResolver(projectRoot)` → `new LlmIntentResolver(projectRoot, activeRuntime.candidateAvailability)`.
- [src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts) — construct `FsCandidateAvailability` BEFORE `AgentAdapter`; expose `get candidateAvailability()`; dispose in `dispose()`.
- [src/agents/config-schema.ts](../../../src/agents/config-schema.ts) — add `runtime.candidateAvailabilityCompactBytes` (default `262144`).

Tests to add:
- [tests/agents/candidate-availability.test.ts](../../../tests/agents/candidate-availability.test.ts) — `HEALTHY → BLOCKED_UNTIL on explicit untilMs`; monotonic-`untilMs`; `markSucceeded` clears state; `untilMs = now + 24h` honoured **verbatim** (no cap); `untilMs <= now` discarded (sign-check); concurrent-writer rejection via `CandidateAvailabilityLockedError`.
- Update [tests/agents/invocation-recovery-policy.test.ts](../../../tests/agents/invocation-recovery-policy.test.ts) and [tests/agents/model-router.test.ts](../../../tests/agents/model-router.test.ts) to assert `decision.availability` and `availability.isAvailable`.

Validation:
- `npx tsc --noEmit`
- `npm test -- --runTestsByPath tests/agents/candidate-availability.test.ts tests/agents/invocation-recovery-policy.test.ts tests/agents/model-router.test.ts tests/agents/agent-adapter-recovery.test.ts`
- `npm test`

Live probe: deploy per §5; on first start verify `.saivage/runtime/candidate-availability.jsonl` and `.saivage/runtime/candidate-availability.lock` are created; `curl -fsS http://10.0.3.170:8080/health` ⇒ 200.

Rollback: `git revert <sha>`; redeploy prior `dist/`; delete `.saivage/runtime/candidate-availability.{jsonl,lock}` on the container before restart (the file is unread by the prior dist).

Commit message: `F03: replace ProviderRegistry in-memory health with on-disk CandidateAvailability; honour provider Retry-After/resets_at verbatim`.

---

### M04 — F05 B1: additive substrate (purely additive, fully green)

Source: [F05/03-plan-r7.md §3 Batch B1](F05-envelope-vs-toolcalls-orthogonality/03-plan-r7.md). **r2 reconciliation**: this batch does NOT add any new exception class. Terminal-protocol and persisted-shape contract violations are reported by constructing typed values `new LlmRequestError({ kind: 'contract_mismatch', subtype, provider, message, ... })` against the F08 union created at M02. The `ContractMismatchSubtype` enum is owned by [src/agents/llm-failure.ts](../../../src/agents/llm-failure.ts) (M02); B1 only consumes it.

Files created:
- [src/agents/role-envelope-schemas.ts](../../../src/agents/role-envelope-schemas.ts) — verbatim MOVE the three role Zod schemas out of `result-parser.ts`.
- [src/agents/zod-to-jsonschema-mini.ts](../../../src/agents/zod-to-jsonschema-mini.ts) — with `ZodUnknown` / `ZodRecord` support.
- [src/agents/role-result-tools.ts](../../../src/agents/role-result-tools.ts).
- [src/agents/persisted-tool-call.ts](../../../src/agents/persisted-tool-call.ts) — `parseToolCallMessage(row)` raises `LlmRequestError({ kind: 'contract_mismatch', subtype: 'legacy_message_shape', ... })` when it encounters a legacy `{ toolCalls: [...] }` wrapper; raises `subtype: 'tool_arguments_invalid_json'` on malformed `arguments`; raises `subtype: 'tool_arguments_schema_violation'` on a parsed-but-invalid arguments object.
- [web/src/utils/persistedToolCall.ts](../../../web/src/utils/persistedToolCall.ts) — read-only mirror; web has no F08 union so it raises a plain `Error` on malformed input (web-side recovery is not affected; this stays consistent with the architecture-first rule because the runtime owner of the typed union is the Node runtime).
- [src/agents/terminal-protocol.ts](../../../src/agents/terminal-protocol.ts) — `validateTerminalToolCall(call, role)` raises `LlmRequestError({ kind: 'contract_mismatch', subtype: 'terminal_tool_missing' | 'terminal_tool_unexpected', provider, message, ... })`. No `LlmContractMismatchError` class is exported anywhere.

Files modified:
- [src/agents/result-parser.ts](../../../src/agents/result-parser.ts) — delete the three local raw schemas + dependent sub-schemas; re-import under the same identifiers from `role-envelope-schemas.ts`.
- [src/agents/llm-errors.ts](../../../src/agents/llm-errors.ts) — **no new error classes**. (Per r2 reconciliation: r1's planned addition of `LlmContractMismatchError` and `LegacyMessageShapeError` is dropped; the same observability is delivered by `LlmFailure.kind = 'contract_mismatch'` + `ContractMismatchSubtype`.)

Tests to add:
- [tests/agents/zod-to-jsonschema-mini.test.ts](../../../tests/agents/zod-to-jsonschema-mini.test.ts).
- [tests/agents/persisted-tool-call.test.ts](../../../tests/agents/persisted-tool-call.test.ts) — asserts `unwrapFailure(err).kind === 'contract_mismatch'` and `.subtype === 'legacy_message_shape'` for the legacy `{toolCalls:[...]}` wrapper input; asserts `.subtype === 'tool_arguments_invalid_json'` for malformed JSON; asserts `.subtype === 'tool_arguments_schema_violation'` for schema-mismatch.
- [tests/agents/terminal-protocol.test.ts](../../../tests/agents/terminal-protocol.test.ts) — asserts `unwrapFailure(err).kind === 'contract_mismatch'` and `.subtype === 'terminal_tool_missing'` / `'terminal_tool_unexpected'` for the two malformed terminal-call inputs.
- [tests/agents/parse-role-envelope-arguments.test.ts](../../../tests/agents/parse-role-envelope-arguments.test.ts).

Validation:
- `npx tsc --noEmit`
- `npm test -- --runTestsByPath tests/agents/zod-to-jsonschema-mini.test.ts tests/agents/persisted-tool-call.test.ts tests/agents/terminal-protocol.test.ts tests/agents/parse-role-envelope-arguments.test.ts tests/agents/result-parser.test.ts`
- `npm test`; `npm run build`
- Grep gates (must all be empty): `grep -rn 'LlmContractMismatchError\|LegacyMessageShapeError\|class LlmContractMismatch\|class LegacyMessage' src/ tests/ web/src/` ⇒ empty.

Live probe: none (purely additive; no behaviour change). Deploy is optional at this checkpoint.

Rollback: `git revert <sha>`.

Commit message: `F05: add typed substrate (role schemas verbatim moved to role-envelope-schemas.ts, zod-to-jsonschema-mini with ZodUnknown/ZodRecord, terminal-protocol validator, persisted-row helpers — all contract violations raised as LlmRequestError{kind:contract_mismatch, subtype})`.

---

### M05 — F05 B2: contract flip + all consumers + persistence + recorder + schemas + fixtures

Source: [F05/03-plan-r7.md §3 Batch B2](F05-envelope-vs-toolcalls-orthogonality/03-plan-r7.md). This is the only batch that touches the recovery hot path; it is intentionally large to keep the tree compilable at every checkpoint. **r2 reconciliation**: this batch does NOT add an `instanceof LlmContractMismatchError` branch to `InvocationRecoveryPolicy.decideFailure`. The switch arm `case 'contract_mismatch':` is already present from M02 (where it was added to satisfy `assertNever` exhaustiveness); B2 only finalises its behavioural payload and emits the upstream contract-mismatch values from the new consumer code.

Files created:
- [src/agents/llm-options-factory.ts](../../../src/agents/llm-options-factory.ts) — `buildLlmOptions(role, phase, tools, ...)`, plus the test files enumerated in F05 §3 B2 ("Files created").

Files modified — substrate + gateways + adapter + analyst + persistence + runtime + recovery + recorder + exchange + event-catalog + every consumer test fixture. Exhaustive list (with line anchors) lives in F05 §3 B2 "Files modified" and "Files modified — consumer-test fixture rewrites". Headline edits:

- [src/agents/llm-contracts.ts](../../../src/agents/llm-contracts.ts) — replace `LlmCompleteOptions` and `LlmCompleteResult` with the discriminated union per F05 §3 B2; `LlmCallFn` return type becomes `Promise<LlmCompleteResult>`; delete `parsePersistedToolCalls`.
- [src/agents/llm-openai-chat-gateway.ts](../../../src/agents/llm-openai-chat-gateway.ts), [src/agents/llm-openai-codex-gateway.ts](../../../src/agents/llm-openai-codex-gateway.ts) — delete the `response_format` branch; always `parallel_tool_calls = false`; emit per-provider `tool_choice` shape (nested function for chat, flat for codex); finalize to the new union; replace `parsePersistedToolCalls` with `parseToolCallMessage`. Any inline shape check that previously threw a raw `Error` is replaced by `throw new LlmRequestError({ kind: 'contract_mismatch', subtype: 'terminal_tool_missing' | 'terminal_tool_unexpected', provider, message, ... })`.
- [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) — single tools-only loop; `buildLlmOptions(role, mustBeTerminal ? 'terminal' : 'tools', mustBeTerminal ? [terminalTool] : tools, ...)`; delete `handleToolCallsLoop`, `forceFinalAnswer`, `parseToolCallsFromResponse` wrapper; one `serializeToolCallMessage(call)` row per persisted assistant-tool_call; `invocation_succeeded.terminal_tool = ROLE_RESULT_TOOL_NAMES[role]`. When the post-call `validateTerminalToolCall(...)` raises, the resulting `LlmRequestError` propagates through `invokeWithRecovery` and hits the existing F08 switch arm.
- [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts), [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — delete every legacy `{toolCalls:[...]}` wrapper reader; on encountering one, raise `LlmRequestError({ kind: 'contract_mismatch', subtype: 'legacy_message_shape', provider: 'persistence', message: ... })`.
- [src/agents/invocation-recovery-policy.ts](../../../src/agents/invocation-recovery-policy.ts) — **finalise** (do not add) the `case 'contract_mismatch':` switch arm introduced at M02; behavioural payload is `{ action: 'fail_invocation', markFailed: false, appendModelIssue: true, abort: true }`. No `instanceof` branch is added. No class import is added. The arm reads `failure.subtype` only to populate `appendModelIssue` diagnostics.
- [src/agents/llm-recording.ts](../../../src/agents/llm-recording.ts), [src/agents/llm-exchange-recorder.ts](../../../src/agents/llm-exchange-recorder.ts), [src/contracts/llm-exchange.ts](../../../src/contracts/llm-exchange.ts), [src/schemas/event-catalog.ts](../../../src/schemas/event-catalog.ts), [src/schemas/types.ts](../../../src/schemas/types.ts), [src/schemas/validators.ts](../../../src/schemas/validators.ts) — wire `terminalTool` / `terminal_tool` per F05 §3 B2.

Tests to add/update:
- [tests/agents/invocation-recovery-policy.test.ts](../../../tests/agents/invocation-recovery-policy.test.ts) — extend the M02 placeholder for `case 'contract_mismatch'` to assert the full behavioural payload `{ action: 'fail_invocation', markFailed: false, appendModelIssue: true, abort: true }` for each `ContractMismatchSubtype` value; assert that `appendModelIssue` text reflects `failure.subtype`.
- [tests/agents/agent-adapter-recovery.test.ts](../../../tests/agents/agent-adapter-recovery.test.ts) — `terminal_tool missing on the wire → recovery aborts the invocation, does NOT mark candidate failed, appends a model-issue note containing the subtype name`; same for `terminal_tool_unexpected`; same for `legacy_message_shape` raised from session-persistence on replay.
- [tests/agents/session-persistence-contract.test.ts](../../../tests/agents/session-persistence-contract.test.ts) (new) — feeding a legacy `{toolCalls:[...]}` row raises `LlmRequestError` with `failure.kind === 'contract_mismatch'` and `failure.subtype === 'legacy_message_shape'`.
- Plus every consumer-fixture rewrite enumerated in F05 §3 B2.

Validation: per F05 §3 B2 — `npx tsc --noEmit`, `npm test`, `cd web && npx tsc --noEmit`, `cd web && npm test`. Grep checkpoints (must all be empty):
- `grep -n 'response_format' src/agents/llm-openai-chat-gateway.ts`
- `grep -n 'parallel_tool_calls' src/agents/llm-openai-codex-gateway.ts | grep -v false`
- `grep -rn 'handleToolCallsLoop\|forceFinalAnswer\|parseToolCallsFromResponse\|parsePersistedToolCalls' src/`
- `grep -n '\.toolCalls' src/agents/session-persistence.ts src/runtime/runtime.ts`
- `grep -rn 'LlmContractMismatchError\|LegacyMessageShapeError\|instanceof LlmContractMismatch\|instanceof LegacyMessage' src/ tests/ web/src/` ⇒ empty (r2 invariant)
- `grep -nE 'instanceof\s+\w*(ContractMismatch|LegacyMessage)' src/agents/invocation-recovery-policy.ts` ⇒ empty (r2 invariant)

Live probe: deploy per §5; `curl -fsS http://10.0.3.170:8080/health` ⇒ 200. The B6 live probe (M10) is the authoritative wire-contract verification.

Rollback: `git revert <sha>` (atomic single commit per F05 §5); redeploy prior `dist/`; do NOT split the revert.

Commit message: `F05: flip LlmCompleteOptions/Result/CallFn to tools-only union; gateways/adapter/analyst/session-persistence/runtime + finalise contract_mismatch recovery arm via typed LlmFailure (no new error classes)`.

---

### M06 — F06: tool-definition typed serializer + gateway swap-ins

Source: [F06/COMBINED-r3.md §2](F06-tool-definition-typed-serializer/COMBINED-r3.md). Inserted **between F05-B2 and F05-B3** because (a) F05-B2 has just rewritten the gateways' wire-shape code so the swap-in lands on clean bodies, and (b) F06's scope is disjoint from F05's message-serialization layer (F06 owns the top-level `tools[]` definition; F05 owns assistant `tool_calls` items).

Files created: [src/agents/tool-definition-serializer.ts](../../../src/agents/tool-definition-serializer.ts) — `RuntimeToolEntry` union (`ToolDefinition | ToolRegistrySchemaEntry`); `WireToolDefinitionChat`, `WireToolDefinitionCodex` nominal types; `serializeToolsForChat`, `serializeToolsForCodex`; `deepFreezeJson`; `assertProjectableEntry`.

Files modified:
- [src/agents/llm-openai-chat-gateway.ts](../../../src/agents/llm-openai-chat-gateway.ts) — replace the inline `opts.tools.map((t) => ({ type: t.type, function: t.function }))` with `serializeToolsForChat(opts.tools)`; widen the `tools` option type to `RuntimeToolEntry[]`.
- [src/agents/llm-openai-codex-gateway.ts](../../../src/agents/llm-openai-codex-gateway.ts) — replace `opts.tools.map(codexTool)` with `serializeToolsForCodex(opts.tools)`; delete the private `codexTool` helper and the private `CodexTool` interface.

Tests to add: [tests/agents/tool-definition-serializer.test.ts](../../../tests/agents/tool-definition-serializer.test.ts) — snapshot of the wire shape for chat and codex; assertion that `roles` and `action` are dropped; assertion that mutating the returned `parameters` subtree throws `TypeError` (deep-freeze proof); rejection of malformed entries.

Validation:
- `npx tsc --noEmit`
- `npm test -- --runTestsByPath tests/agents/tool-definition-serializer.test.ts tests/agents/llm-openai-chat-gateway-request.test.ts tests/agents/llm-openai-codex-gateway-request.test.ts`
- `npm test`

Live probe: deploy per §5; `curl -fsS http://10.0.3.170:8080/health` ⇒ 200; if `dist/src/scripts/probe-llm-contract.js` is already present from a prior M10 run, re-execute it to confirm the wire shape stayed correct (otherwise the probe lands in M10).

Rollback: `git revert <sha>`; redeploy prior `dist/`.

Commit message: `F06: extract typed tool-definition serializer; delete inline codexTool helper and per-gateway wire reshape`.

---

### M07 — F05 B3: delete `result-parser.ts` family + integration test rewrite

Source: [F05/03-plan-r7.md §3 Batch B3](F05-envelope-vs-toolcalls-orthogonality/03-plan-r7.md).

Files modified: [tests/agents/integration.test.ts](../../../tests/agents/integration.test.ts) — drive `AgentAdapter.invokeAgent` against a fake gateway returning a terminal `emit_<role>_result` call per role; assert envelopes parse against the moved Zod schemas.

Files deleted: [src/agents/result-parser.ts](../../../src/agents/result-parser.ts), [tests/agents/result-parser.test.ts](../../../tests/agents/result-parser.test.ts), [tests/agents/agent-adapter-executor-fallback.test.ts](../../../tests/agents/agent-adapter-executor-fallback.test.ts).

Validation:
- `npx tsc --noEmit`
- `npm test -- --runTestsByPath tests/agents/integration.test.ts`
- `npm test`
- Grep: `grep -rn 'extractJson\|parsePlannerResult\|parseExecutorResult\|parseReviewerResult\|ResultParseError\|buildExecutorFallbackResult' src/ web/src/ tests/` ⇒ empty.

Live probe: deploy per §5; `curl -fsS http://10.0.3.170:8080/health`.

Rollback: `git revert <sha>`; redeploy prior `dist/`.

Commit message: `F05: delete result-parser.ts family (schemas already in role-envelope-schemas.ts since B1)`.

---

### M08 — F05 B4: capability axis cleanup

Source: [F05/03-plan-r7.md §3 Batch B4](F05-envelope-vs-toolcalls-orthogonality/03-plan-r7.md).

Files modified: [src/agents/provider-capabilities.ts](../../../src/agents/provider-capabilities.ts) — replace tool axes with `toolsMode: 'native' | 'unsupported'` and `exclusiveToolChoiceSupport: 'native' | 'parallel_off' | 'unsupported'`; delete `responseFormat`, `envelopeMode`, `responseShape`; set `opencode`, `opencode-go`, `github-copilot`, `nvidia-nim` ⇒ `{ toolsMode: 'native', exclusiveToolChoiceSupport: 'native' }`; `openai-codex` ⇒ `{ toolsMode: 'native', exclusiveToolChoiceSupport: 'parallel_off' }`; `capabilityRequestForLlmOptions` always emits `requiresExclusiveToolChoice: true`.

Plus the capability fixture rewrites in [tests/agents/agent-adapter-recovery.test.ts](../../../tests/agents/agent-adapter-recovery.test.ts), [tests/agents/config-schema.test.ts](../../../tests/agents/config-schema.test.ts), [tests/agents/llm-client-integration.test.ts](../../../tests/agents/llm-client-integration.test.ts), [tests/agents/model-router.test.ts](../../../tests/agents/model-router.test.ts), [tests/agents/provider.test.ts](../../../tests/agents/provider.test.ts).

Tests to add: [tests/agents/provider-capabilities-axis.test.ts](../../../tests/agents/provider-capabilities-axis.test.ts).

Validation:
- `npx tsc --noEmit`
- `npm test -- --runTestsByPath tests/agents/provider-capabilities-axis.test.ts tests/agents/agent-adapter-recovery.test.ts tests/agents/model-router.test.ts tests/agents/provider.test.ts tests/agents/config-schema.test.ts tests/agents/llm-client-integration.test.ts`
- `npm test`
- Grep: `grep -rn 'envelopeMode\|responseShape' src/ tests/` ⇒ empty.

Live probe: deploy per §5; `curl -fsS http://10.0.3.170:8080/health`.

Rollback: `git revert <sha>`; redeploy prior `dist/`.

Commit message: `F05: swap capability axes to toolsMode + exclusiveToolChoiceSupport; delete envelopeMode/responseShape`.

---

### M09 — F05 B5: web migration (presenters, stores, viewer, event-log badge)

Source: [F05/03-plan-r7.md §3 Batch B5](F05-envelope-vs-toolcalls-orthogonality/03-plan-r7.md).

Files modified: [web/src/utils/tool-presenters/helpers.ts](../../../web/src/utils/tool-presenters/helpers.ts) (rename `readToolCallEnvelope` → `readToolCallMessage`); [web/src/utils/tool-presenters/registry.ts](../../../web/src/utils/tool-presenters/registry.ts); [web/src/stores/analystChat.ts](../../../web/src/stores/analystChat.ts); the LLM-exchange viewer component (locate via `grep -rln 'terminalTool\|LlmExchange' web/src/components/`) — render the terminal-tool badge when `attempt.terminalTool !== null`; the event-log row component for `invocation_succeeded`; [web/src/__tests__/tool-presenters/registry.test.ts](../../../web/src/__tests__/tool-presenters/registry.test.ts); [web/src/__tests__/analyst-chat-store.test.ts](../../../web/src/__tests__/analyst-chat-store.test.ts).

Tests to add: [web/src/__tests__/tool-presenters/terminal-tool-viewer.test.ts](../../../web/src/__tests__/tool-presenters/terminal-tool-viewer.test.ts); [web/src/__tests__/event-log-terminal-tool.test.ts](../../../web/src/__tests__/event-log-terminal-tool.test.ts).

Validation (web changes — Vitest only here):
- `workbench.action.files.saveAll`, then `for f in web/src/components/*.vue web/src/App.vue; do echo "$(grep -c '<script setup>' "$f") $(basename "$f")"; done` — every count ≤ 1.
- `cd web && npx tsc --noEmit`
- `cd web && npx vitest run src/__tests__/analyst-chat-store.test.ts src/__tests__/tool-presenters/registry.test.ts src/__tests__/tool-presenters/terminal-tool-viewer.test.ts src/__tests__/event-log-terminal-tool.test.ts`
- `cd web && npm test`
- `npm test` (root guardrail)
- `npm run build` (catches duplicate `<script setup>` blocks).

Live probe: deploy per §5; open the Cards / Agents dashboards in the integrated browser and confirm the badge renders.

Rollback: `git revert <sha>`; redeploy prior `dist/`. If Vue SFCs corrupted mid-edit, run `git checkout web/src/...` per the user-memory `vue-sfc-corruption.md` note.

Commit message: `F05: web — rename to readToolCallMessage, one-row-per-toolcall reads, render terminal_tool badge`.

---

### M10 — F05 B6: final sweep + live probe playbook

Source: [F05/03-plan-r7.md §3 Batch B6](F05-envelope-vs-toolcalls-orthogonality/03-plan-r7.md).

Files created: [src/scripts/probe-llm-contract.ts](../../../src/scripts/probe-llm-contract.ts) (per-provider × per-role probe; reads only `.saivage/saivage.json`; never reads `.saivage/auth-profiles.json`; emits one JSON line per `{provider, role, status}`); [scripts/README-probe-llm-contract.md](../../../scripts/README-probe-llm-contract.md); [scripts/check-no-legacy-toolcalls-wrapper.sh](../../../scripts/check-no-legacy-toolcalls-wrapper.sh).

Sweep commands (the shell script wraps these; exits non-zero on any hit). Verbatim from F05 §3 B6 plus the r2 contract-class invariant:

```bash
! grep -rn "response_format\|\.toolCalls" src/ --include='*.ts' | grep -v 'never_sends\|deprecated_marker'
! grep -rn "extractJson\|parsePersistedToolCalls\|parseToolCallsFromResponse\|envelopeMode\|responseShape\|forceFinalAnswer\|handleToolCallsLoop\|ResultParseError\|buildExecutorFallbackResult\|parsePlannerResult\|parseExecutorResult\|parseReviewerResult\|LlmEnvelopeOptions" src/ --include='*.ts' | grep -v 'deprecated_marker'
! grep -rn "toolCalls:" tests/ web/src/__tests__/ web/src/utils/ | grep -v "capabilities:"
! grep -n "response_format" src/agents/llm-openai-chat-gateway.ts src/agents/llm-openai-codex-gateway.ts
! grep -n "parallel_tool_calls" src/agents/llm-openai-chat-gateway.ts src/agents/llm-openai-codex-gateway.ts | grep -v "false"
! grep -rn "LlmContractMismatchError\|LegacyMessageShapeError" src/ tests/ web/src/   # r2: never re-introduce class-based contract errors
! grep -rnE "instanceof\s+\w*(ContractMismatch|LegacyMessage)" src/ tests/ web/src/   # r2: recovery branches must be switch-based on failure.kind
```

Validation:
- `npx tsc --noEmit`
- `npm run build`; `ls dist/src/scripts/probe-llm-contract.js` ⇒ exists.
- `npm test`; `cd web && npm test`
- `bash scripts/check-no-legacy-toolcalls-wrapper.sh` ⇒ exit 0.

Live probe (the playbook the operator runs from the workstation):

```bash
npm run build
rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3/dist/
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
ssh salva@10.0.3.170 'cd /work/getrich-v2 && node /opt/saivage-v3/dist/src/scripts/probe-llm-contract.js'
```

Every probe line MUST show `status: "ok"`. A `contract_mismatch:<subtype>` line is a real wire bug — file a follow-up F-issue.

Rollback: `git revert <sha>` removes the sweep script and probe. The runtime change from M05/M06/M07/M08/M09 is unaffected. If the probe script itself crashes, revert only this commit.

Commit message: `F05: add legacy-wrapper sweep script (production-source-scoped) and probe-llm-contract live playbook`.

---

### M11 — F04: canonical `llm_attempt` + `llm_invocation_summary`

Source: [F04/COMBINED-r3.md §3](F04-observability-event-gaps/COMBINED-r3.md). Lands LAST because it consumes (a) the typed `LlmFailure` from M02 for the `failed` outcome and (b) the `terminal_tool` from M05 for the `succeeded` outcome.

Files modified — schema layer:
- [src/schemas/event-catalog.ts](../../../src/schemas/event-catalog.ts) — widen the `RegistryEntry` shape to `{ baseShape: ZodRawShape; refine?: (data, ctx) => void; strict: boolean; ... }`; convert every existing `schema: payload({...})` to `baseShape: {...}, strict: false`; add `llm_attempt` (strict) and `llm_invocation_summary` (strict + `llmInvocationSummaryRefine`); rewrite `buildLoggedEventSchema` per F04 §2.2 (no `(entry.schema as z.AnyZodObject).shape`); DELETE `model_selected`, `invocation_succeeded`, `invocation_failed`, `retry_attempted` catalog entries.
- [src/schemas/validators.ts](../../../src/schemas/validators.ts) — add `composeStrictKind`; export `llmAttemptEventSchema`, `llmInvocationSummaryEventSchema`; DELETE the four legacy standalone validators.
- [src/schemas/types.ts](../../../src/schemas/types.ts) — add `LlmAttemptEvent`, `LlmInvocationSummaryEvent`, `LlmAttemptOutcome`, `LlmAttemptPayload`; remove the four legacy interfaces; extend `LoggedEvent` union.

Files modified — emission layer:
- [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) — define `recordAttemptOutcome(outcome)` per F04 §2.2 with a local `let attemptOutcomeCount = 0` (counts EMITTED rows, NOT `attempts.length`); replace the L334–L335 `model_selected`, L399–L400 `invocation_succeeded`, L410–L411 `invocation_failed` emissions with `recordAttemptOutcome({ kind: 'succeeded', terminal_tool: ROLE_RESULT_TOOL_NAMES[role] })` / `recordAttemptOutcome({ kind: 'failed', failure_class: decision.failure.kind, ... })`; DELETE the L329 `persistFailure → retry_attempted` emission and the L416–L418 inner `retry_same_after_delay → retry_attempted` emission; emit `llm_invocation_summary` in `invokeAgent` after `invokeWithRecovery` returns, computing `attempts_count = attemptOutcomeCount`; populate `final_*` from `lastSucceededAttemptPayload`; populate `last_failure_class` from `lastFailedFailureClass`.

Files modified — web consumer layer:
- [web/src/stores/debug-read-model.ts](../../../web/src/stores/debug-read-model.ts) — replace the legacy regex with `^llm_attempt$|_error$|_failed$`; severity rule keys off `event.outcome.kind`.
- [web/src/components/cards/CardEventLogRow.vue](../../../web/src/components/cards/CardEventLogRow.vue) — render `llm_attempt` with `attempt`, `provider/model`, `duration_ms`, `outcome.kind`, `outcome.failure_class`; render `llm_invocation_summary` as a pinned row with the verdict badge.
- [web/src/components/agents/AgentSessionTimeline.vue](../../../web/src/components/agents/AgentSessionTimeline.vue) — group consecutive `llm_attempt` rows under their matching `llm_invocation_summary` parent.
- [web/src/composables/useAgentInvocationGroups.ts](../../../web/src/composables/useAgentInvocationGroups.ts) (new) — exposes `{ summary, attempts[] }` tuples.
- [web/src/components/cards/CardEventLogFilters.vue](../../../web/src/components/cards/CardEventLogFilters.vue) — drop the four deleted kinds; add the two new kinds.

Tests to add/update (named cases per F04 §3 B1–B4):
- [tests/schemas/event-catalog.test.ts](../../../tests/schemas/event-catalog.test.ts), [tests/schemas/validators.test.ts](../../../tests/schemas/validators.test.ts) — `llm_attempt schema accepts succeeded outcome`, `accepts failed outcome with cooldown_ms + retry_delay_ms`, `REJECTS missing terminal_tool on succeeded outcome`, `REJECTS missing failure_class on failed outcome`, `REJECTS unknown top-level field`; cross-schema-path tests asserting `loggedEventSchema`, `loggedEventSchemaByKind.llm_invocation_summary`, AND `validators.llmInvocationSummaryEventSchema` all reject invalid `verdict↔final-field` combinations and unknown keys.
- [tests/agents/agent-adapter-llm-attempt.test.ts](../../../tests/agents/agent-adapter-llm-attempt.test.ts) (new) — 3-HTTP-failure failover test asserts `attempts_count === 3` even though `attempts.length === 1`; cardinality invariant test (exactly ONE `llm_attempt` per candidate × HTTP call); `failure_class === 'contract_mismatch'` populates correctly when the candidate fails via the M05 terminal-protocol path.

Validation:
- `npx tsc --noEmit`; `cd web && npx tsc --noEmit`
- `npm test -- --runTestsByPath tests/schemas/event-catalog.test.ts tests/schemas/validators.test.ts tests/agents/agent-adapter-llm-attempt.test.ts`
- `npm test`; `cd web && npm test`
- Grep: `grep -rn "'model_selected'\|'invocation_succeeded'\|'invocation_failed'\|'retry_attempted'" src/ web/src/ tests/` ⇒ empty.

Live probe: deploy per §5; trigger one role invocation via the dashboard; `ssh salva@10.0.3.170 'tail -n 200 /work/getrich-v2/.saivage/events.jsonl | grep llm_attempt\\|llm_invocation_summary'` shows the new event kinds with all required fields populated; the dashboard's Agents timeline renders the grouped view.

Rollback: `git revert <sha>`; redeploy prior `dist/`. The legacy four event kinds return; no data migration is needed because JSONL is append-only.

Commit message: `F04: canonical llm_attempt + llm_invocation_summary; delete model_selected/invocation_succeeded/invocation_failed/retry_attempted`.

---

## 5. Cross-cutting deploy procedure

Verified container: `saivage-v3-getrich-v2` at `10.0.3.170:8080`; service `saivage-v3-getrich.service`; build host is `/home/salva/g/ml/saivage-v3`. Per workspace memory `saivage-v3-build-deploy.json`.

```bash
cd /home/salva/g/ml/saivage-v3
npm run build
rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3/dist/
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
# Optional, only after M10 ships the probe artifact:
ssh salva@10.0.3.170 'cd /work/getrich-v2 && node /opt/saivage-v3/dist/src/scripts/probe-llm-contract.js'
```

Do NOT read `.saivage/auth-profiles.json` or any provider-secret file at any point in this loop (per workspace operational rules). Do NOT use `~/.saivage`; runtime state stays under `/work/getrich-v2/.saivage/`.

Rollback shape (any batch): `git revert <sha>` on the host, `npm run build`, rsync the resulting `dist/`, restart the service, re-run health. For F03 (M03) specifically: also delete `.saivage/runtime/candidate-availability.{jsonl,lock}` on the container before restart so the prior dist does not trip over the new file.

---

## 6. Risk register

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **VS Code SFC corruption mid-batch** (Vue SFC ends up with two `<script setup>` blocks after `replace_string_in_file` on `web/src/...`). Hits primarily M09. | Before every web build run `for f in web/src/components/*.vue web/src/App.vue; do echo "$(grep -c '<script setup>' "$f") $(basename "$f")"; done` (per user memory `vue-sfc-corruption.md`); any count > 1 is corrupted; truncate the duplicate block via `head -N file > /tmp/fix.vue && mv /tmp/fix.vue file`. Always run `workbench.action.files.saveAll` after edits and BEFORE `npm run build`. Detection lands in CI via M10's sweep + the web build step. |
| R2 | **Stale TS buffer reverts** (`replace_string_in_file` succeeds in the VS Code buffer, disk briefly shows the new content, then `workbench.action.files.saveAll` overwrites the disk file from a stale buffer; `tsc` builds the OLD content). Hits M02, M03, M05, M11 (large multi-file edits on dense `.ts` files). | After every edit on `src/agents/*.ts` or `src/schemas/*.ts`, verify with `grep -c <new-token> <file>` from a terminal (NOT via `read_file`) BEFORE running `npx tsc --noEmit`. On reverting buffer behaviour, `git checkout <file>` and ask the user to restart VS Code, then redo edits using `multi_replace_string_in_file` (single transaction) rather than chained `replace_string_in_file` calls. Per user memory `vue-sfc-corruption.md`. |
| R3 | **Container service restart race** (`systemctl restart saivage-v3-getrich.service` fires before `rsync` has finished writing `dist/`; the new process starts on a half-written tree and crashes; the next `curl /health` returns a stale 200 from a previously-started worker). | Run `rsync` to completion (no `&`, no async); only then `ssh root@10.0.3.170 'systemctl restart ...'`; immediately follow with `curl -fsS http://10.0.3.170:8080/health` and then `ssh root@10.0.3.170 'journalctl -u saivage-v3-getrich.service -n 50 --no-pager'` — confirm the unit reports `active (running)` and the timestamp of the latest start matches the restart. If the health 200 returns within < 100 ms of the restart command, treat as suspicious and re-check. |
| R4 | **Jest vs Vitest confusion** (running `npx vitest run <path>` against a root test file, or `npm test -- --runTestsByPath <path>` against a web test). The runners reject each other's invocations with confusing errors. | Per F05 §0: root project is Jest, web is Vitest. Root specific files: `npm test -- --runTestsByPath <abs paths>`. Web specific files: `cd web && npx vitest run <web-relative path>`. Every per-batch `Validation` section in §4 above writes the correct invocation explicitly; do not paraphrase. |
| R5 | **Dropped tool-call envelope during F05 cutover** (the per-provider `tool_choice` JSON shape is mis-implemented: chat emits the flat `{ type: 'function', name }` form, OR codex emits the nested `{ type: 'function', function: { name } }` form. The codex transport silently accepts the request and either ignores the forced tool choice or 400s intermittently). Hits M05 most acutely. | Per F05 §5 single-biggest-risk: keep TWO SEPARATE test files asserting wire JSON literal shapes against per-provider expectations (`tests/agents/llm-openai-chat-gateway-request.test.ts` asserts the nested form, `tests/agents/llm-openai-codex-gateway-request.test.ts` asserts the flat form). Do NOT share an assertion helper between the two — that re-introduces the bug. The M10 live probe (`probe-llm-contract.js`) is the post-deploy detector: a `contract_mismatch:terminal_*` line on any provider × role row indicates a wire-shape regression. |
| R6 | **r2-specific: contract-mismatch class regression** — a developer reflexively re-adds `class LlmContractMismatchError extends Error` to `src/agents/llm-errors.ts` (or imports an old `LegacyMessageShapeError` alias) when wiring M05 consumers, then patches `InvocationRecoveryPolicy.decideFailure` with `if (err instanceof LlmContractMismatchError)`. This re-fragments the failure surface and silently bypasses the F08 switch. | M04 and M05 grep gates above forbid the class symbols; M10 sweep script repeats both greps (`LlmContractMismatchError\|LegacyMessageShapeError` and `instanceof.*ContractMismatch|LegacyMessage`) so any reintroduction at any later batch trips the sweep before merge. The recovery-policy test file pins the `case 'contract_mismatch':` switch-arm behaviour to a typed `LlmRequestError(LlmFailure)` value, not an exception subclass. |

---

## 7. Definition of done (whole metaplan)

- All 11 batches landed; each commit message matches the `F0X: <verb-phrase>` shape listed above.
- `npx tsc --noEmit` clean; `cd web && npx tsc --noEmit` clean.
- `npm test` and `cd web && npm test` green.
- `bash scripts/check-no-legacy-toolcalls-wrapper.sh` exits 0 (includes the r2 contract-class invariant greps).
- `curl -fsS http://10.0.3.170:8080/health` returns 200.
- `node /opt/saivage-v3/dist/src/scripts/probe-llm-contract.js` reports `status: "ok"` for every configured `(provider, role)` pair.
- Live `/work/getrich-v2/.saivage/saivage.json` shows two role overrides (`chat`, `analyst`), `models.default` set, no root `failover`, no schema-rejection diagnostics in `journalctl`.
- `/work/getrich-v2/.saivage/runtime/candidate-availability.jsonl` exists and accumulates rows.
- Dashboard's Agents timeline renders `llm_attempt` rows grouped under `llm_invocation_summary` parents; cards event log shows the `terminal_tool` badge.
- No `LlmContractMismatchError` / `LegacyMessageShapeError` class symbols anywhere in `src/`, `tests/`, or `web/src/`; no `instanceof *ContractMismatch*` / `instanceof *LegacyMessage*` branches anywhere; `InvocationRecoveryPolicy.decideFailure` is a single `switch (failure.kind)` over the F08 union with `assertNever`.
- F03, F04, F05, F06, F07, F08 closed.
