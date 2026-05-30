# S10 — Test suite update: analyst playwright + unit/integration; final ledger reconciliation [AUDIT] — design

## Goal

Bring the entire automated test surface — the
[`saivage-e2e-checkers`](../../../../../../saivage-e2e-checkers/e2e/analyst/scenarios.spec.js)
analyst playwright suite, the saivage-v3 jest unit/integration
suite, and the saivage-v3/web vitest suite — into byte-for-byte
alignment with the post-S09 state of the codebase and with every
acceptance clause of [SPEC-r7](../../../SPEC-r7.md), then
**verify the cumulative breakage ledger is empty** and
**refresh the S00 baseline-gates snapshot** so the four gates
(`tsc-build`, `web-vite-build`, `web-vitest`, `analyst-e2e`) all
record `failing_ids: []` against the post-S10 source tree.

The substantive observable outcomes are:

1. The eight existing analyst playwright scenarios in
   [`saivage-e2e-checkers/e2e/analyst/scenarios.spec.js`](../../../../../../saivage-e2e-checkers/e2e/analyst/scenarios.spec.js)
   move from S1 PASS / S2–S8 LIMITATION (per the live findings
   file
   [`saivage-e2e-checkers/e2e/analyst/findings/findings.md`](../../../../../../saivage-e2e-checkers/e2e/analyst/findings/findings.md))
   to S1–S8 all PASS. Each scenario's user-facing prompt text,
   number of turns, and tested intent are preserved verbatim;
   only the analyst's behavior (and, where the failure is a
   genuine missing capability filed against a published stage,
   the source state that S10 inherits) changes between LIMITATION
   and PASS.
2. Every "Required new test coverage" row from MASTER-PLAN-r7
   §S10 — fifteen rows in total — is exercised end-to-end by at
   least one new analyst playwright scenario. The fifteen rows
   are enumerated below in "Approach → 15-row coverage matrix"
   and are repeated as one row each in `## Test plan` of this
   file; every row has a corresponding discrete substep in
   [`plan.md`](plan.md) Phase C.
3. Every UI surface listed in MASTER-PLAN-r7 §4.1 — the seven
   surfaces named in the
   "Ordered-child rendering matrix (closes section 4.1)" bullet
   — is exercised by at least one analyst playwright scenario
   whose fixture shuffles the `position` vector and whose
   assertion confirms the rendered order matches `position`.
   The analyst-chat-context-list surface is covered by S10's
   own e2e regardless of any pre-existing S08 vitest; the e2e
   coverage is the substantive S10 contribution and is **not**
   substituted by unit-test coverage.
4. Every test file in the saivage-v3 trees whose subject was
   removed by S04 (notification mutator surface), S05 (operator
   chat-host control verbs), S06 (UI mutation widgets), S07
   (operator API pruning), or S09 (operator events surface
   cleanup) is **deleted from disk**, not skipped, not
   `.todo`'d, not commented out.
5. The cumulative ledger
   [`expected-breakage-ledger.md`](../../expected-breakage-ledger.md)
   ends S10 **header-only with zero OPEN entries**. The
   ledger-as-open-entries-only contract is honored, the
   `## Open entries` section header is the only structural
   content beneath the entry-shape header, and the H.4 close
   gate confirms `grep -c '^### '` reports `0`.
6. The S00 baseline snapshot
   [`baseline-gates.json`](../../baseline-gates.json) is
   **regenerated against the post-S10 source** by
   `run-gates.sh --baseline`, so every gate's `failing_ids`
   array is `[]` and every gate's `observed_exit_code` is `0`
   at the moment the snapshot is captured. This is the single
   substantive baseline-refresh moment in the eleven-stage
   plan.

S10 is the **final stage** of the analyst-as-control-surface
migration. If any of the four gates cannot reach
`failing_ids: []` against the post-S10 source, or any OPEN
ledger entry cannot be resolved in-stage, S10 **MUST NOT
publish**: the implementer opens a follow-up stage at
`011-<slug>/` per MASTER-PLAN-r7 §7 and the follow-up stage
takes ownership of the un-repairable work. **S10's own
close-out never appends ledger entries.** Any escalation
ledger entry is authored as part of the follow-up stage's
close-out, lives in that follow-up stage's evidence trail,
and names `S11` (the published id of the follow-up stage) as
its target. The escalation protocol is detailed in the
"Approach → Un-repairable failures and follow-up escalation"
section.

## Scope

### In scope

- **Repair the eight existing analyst playwright scenarios**
  (S1–S8 in
  `saivage-e2e-checkers/e2e/analyst/scenarios.spec.js`) so each
  scenario's verdict is a deterministic `PASS` **while
  preserving the scenario's wording, turn structure, and tested
  intent**. The live findings file
  `saivage-e2e-checkers/e2e/analyst/findings/findings.md`
  records S1 PASS and S2–S8 LIMITATION. The per-scenario repair
  rules, including the explicit attribution of the
  `confirmed/preview_hash` apology line to S2 (not S7), are
  enumerated below in "Approach → S1–S8 repair plan". The
  repair work uses the REAL Analyst driven by the configured
  analyst-capable provider, not an offline keyword fallback;
  SPEC-r7 forbids the degraded keyword fallback path and S01
  removed it from the runtime.
- **Author new analyst playwright scenarios** covering every
  row of the MASTER-PLAN-r7 §S10 "Required new test coverage"
  matrix. The fifteen rows are enumerated below in "Approach →
  15-row coverage matrix"; each row has one or more discrete
  substeps in `plan.md` Phase C and at least one corresponding
  entry in `## Test plan` of this file.
- **Drive the REAL Analyst** against the analyst-capable
  provider that the test fixture's `bootSaivageServer`
  configures. Per MASTER-PLAN-r7 §S10 risk-mitigation, the
  analyst suite **pins a fixed analyst model** so the assertion
  text and tool-call sequence are reproducible, and **surfaces
  transient provider errors as test-infrastructure failures**
  distinguishable from product failures (a test-infra failure
  is a 5xx-or-timeout from the provider; a product failure is
  the analyst's reply or tool sequence failing an assertion).
  The fixture's pinning and the infra-vs-product
  classification are described in "Approach → REAL-Analyst
  test discipline".
- **Delete unit and integration test files in
  `saivage-v3/tests/`** whose subject is a feature that no
  longer exists in the post-S09 source. The deletion inventory
  is enumerated under "Test file deletion inventory".
- **Delete vitest files in `saivage-v3/web/src/__tests__/`**
  whose subject is a UI surface that no longer exists.
  Inventory enumerated identically.
- **Repair unit and integration test files** that survive but
  contain references to retired tokens (`mark_note_handled`,
  `list_notes`, `preview_hash`) — either by rewriting the
  assertion to use the post-S09 vocabulary or by hex-escaping
  the literal token if the assertion's purpose is to **guard
  against the retired token reappearing** (this preserves the
  negative-assertion semantics while letting the H.10
  forbidden-token grep pass). The `confirmed` token is handled
  separately under "Approach → `confirmed` audit (H.10b)";
  it is NOT subject to the strict zero-hit grep.
- **Replace `findings.md`** with a fresh post-S10 run so the
  recorded verdicts match the new repair work.
- **Verify** the cumulative ledger is header-only with zero
  OPEN entries and, if any entry is present at S10 read time,
  drain each one per its target stage; un-repairable entries
  trigger the escalation protocol below.
- **Regenerate `baseline-gates.json`** by running
  `bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --baseline`
  and committing the resulting snapshot.
- **Run all four gates** at the end of Phase H and confirm
  every gate exits zero with empty `failing_ids`, then publish
  the draft directory via the PROTOCOL-r4 atomic rename
  ceremony.

### Out of scope

- Any change to source code outside the test trees
  (`saivage-v3/tests/`, `saivage-v3/web/src/__tests__/`,
  `saivage-e2e-checkers/e2e/`), the cumulative ledger, the
  baseline snapshot, or the draft directory itself. S10 is a
  **test-suite + reconciliation** stage. If a test failure
  exposes a genuine source-code defect (rather than a test
  that is out of date with the post-S09 source), S10 cannot
  close in-stage — the escalation protocol below opens a
  `011-<slug>` follow-up that owns the source fix.
- Adding new acceptance criteria to SPEC-r7. Every assertion
  in every new or repaired scenario maps to an existing
  SPEC-r7 clause; the mapping is enumerated in the
  "Done-definition cross-reference" section.
- Removing or changing the four gate ids
  (`tsc-build`, `web-vite-build`, `web-vitest`,
  `analyst-e2e`); their identifiers, commands, and
  normalization rules are owned by S00 and are not modified
  by S10. S10 only regenerates the **failing_ids snapshot**,
  not the gate definitions.
- Adding a fifth gate (for example a jest-test gate at the
  saivage-v3 root). Jest is already exercised in CI via
  `npm test` and S10's plan runs it as part of H.8; the
  master plan's four-gate model is unchanged.
- Touching telegram-surface coverage. Telegram is not in the
  analyst-as-control-surface SPEC scope per SPEC-r7 "Out of
  scope" §B and remains untouched by S10.
- Modifying `forbidden-anchors.txt`, the validation cookbook,
  or any earlier stage's `design.md` / `plan.md`. The
  PROTOCOL-r4 immutability rule applies; if a published
  stage's tests are broken in a way S10 cannot repair without
  editing that stage's design, the failure escalates to the
  `011-<slug>` follow-up.
- Adding any new analyst-callable tool. In particular, S10
  does **not** introduce `list_notifications`,
  `get_notification`, or any `acknowledge_notification`-shaped
  analyst tool; the new notification scenario (row 8 of the
  15-row matrix) observes the queue via the existing control-
  action audit log (`GET /api/control-actions`) cross-checked
  with the existing planner-agent conversation route
  (`GET /api/agents/:id/conversation`), and asserts the
  absence of those tools by importing `ANALYST_TOOL_NAMES`
  from the post-S02 source-of-truth module
  `src/agents/analyst-tool-schemas.ts`.

## Dependencies

S10 has the entire eleven-stage chain S00 through S09 as
upstream dependencies and depends on each in a substantively
distinct way:

- **S00 — Breakage-detection harness.** S10 is the only stage
  in the plan that **regenerates** `baseline-gates.json`
  beyond the initial S00 snapshot. S10 reads
  `tmp/s10-baseline-before.json` (captured by Phase A.7) and
  writes `baseline-gates.json` via Phase G's
  `run-gates.sh --baseline` invocation. S10 also uses the
  S00 close-criterion vocabulary verbatim: "A stage may close
  only if every NEW failure relative to baseline-gates.json
  has an open ledger entry naming a later stage" — sharpened
  in S10's case to "and the cumulative ledger contains zero
  OPEN entries at close-out".
- **S01 — Bootstrap and runtime contract.** S10 exercises the
  bootstrap-from-cold-start branch of the
  `bootSaivageServer` fixture in
  `saivage-e2e-checkers/e2e/analyst/fixtures/saivage-server.js`
  for every scenario that starts from an empty `.saivage/`
  directory. S01 removed the offline keyword-fallback path;
  S10's scenarios drive the REAL Analyst against the
  fixture-pinned analyst-capable provider.
- **S02 — Tool surface alignment.** Every analyst tool name
  asserted by S10's new playwright scenarios is one that S02
  declared in `src/agents/analyst-tool-schemas.ts`. S10's
  Phase A.4 cross-references the registry to confirm the
  scenario matrix does not reach for a name S02 did not
  expose, and also that no analyst-callable
  `list_notifications`, `get_notification`, or
  `acknowledge_notification` is present (the notification
  scenario asserts their absence).
- **S03 — Ordered children and bounded move.** S10's new
  bounded-move scenarios assert the four S03-enforced refusal
  modes (cross-tree, out-of-bounds, root, self) and the two
  acceptance modes (up, down). The ordered-child rendering
  matrix in Phase C exercises each of the seven MASTER-PLAN-r7
  §4.1 UI surfaces against a position-shuffled fixture.
- **S04 — Notifications queue (ephemeral).** S10's
  notification-roundtrip scenario uses the SPEC-r7 ephemeral
  contract directly (queue via the analyst's
  `queue_notification`; observe the queue via the existing
  `GET /api/control-actions` audit-log route plus the
  existing `GET /api/agents/:id/conversation` planner-session
  conversation route; exercise a retraction follow-up
  observed through the same two surfaces). The test file
  deletion inventory removes any surviving
  `tests/utils/runtime-queue-notification.test.ts` and any
  vitest under `web/src/__tests__/components/` for retired
  notification widgets.
- **S05 — Right panel and shell.** S10 does not re-assert the
  persistent-panel layout invariant (S05 owns it) but does
  assert that the new "On screen" block introduced by S08
  continues to render in the post-S10 state through the
  analyst-chat-context-list e2e row of the §4.1 matrix.
- **S06 — UI mutation removal and ordered rendering.** S10's
  Phase D deletion inventory removes vitest files for every
  UI mutation widget S06 retired (computed empirically in
  Phase A.2). S10's analyst playwright scenarios additionally
  exercise the read-only affordance preservation acceptance
  bullet (refresh, filter, sort, search, expand/collapse,
  copy-to-clipboard, and navigation across cards, dashboard,
  files, agents, debug).
- **S07 — Operator API pruning.** Phase D removes server jest
  files for retired routes. The surviving
  `tests/server/operator-api-contracts.test.ts` is repaired
  in Phase E via the hex-escape pattern for the three
  forbidden tokens (`mark_note_handled`, `list_notes`,
  `preview_hash`); the `confirmed` token is audited
  separately under "Approach → `confirmed` audit (H.10b)".
- **S08 — Analyst navigation and chat-panel context.** S10
  authors new playwright scenarios that exercise the two
  navigation tools and the per-turn workspace-context payload
  against a live server boot. The deictic scenario asserts
  that "this card" with a workspace-context resolves without
  clarification; the multi-turn-clarification scenario (the
  repaired S8) asserts that a missing-info request elicits a
  clarification turn and is satisfied on the follow-up.
- **S09 — Operator events surface cleanup.** Phase D's
  deletion inventory is finalized against the post-S09 source
  tree; S09 may have already removed candidate files. S10's
  ledger drain begins from S09's published ledger state.

S10 does not depend on any hypothetical S11; any follow-up
`011-<slug>` stage is exclusively a S10-escalation output,
authored alongside the escalation and never a S10 prerequisite.

## Approach

### Architecture summary

S10 is decomposed into four test-suite repair phases (B, C, D,
E) and three reconciliation phases (F, G, H). The repair phases
are mutually independent — analyst-e2e repair does not depend
on vitest deletion, jest repair does not depend on either — so
the Phase ordering in [plan.md](plan.md) is chosen for the
**stable left-to-right read order in close-out** (e2e first
because the analyst playwright suite is the highest-value gate
for SPEC-r7 acceptance evidence), not for any hard data
dependency. Each phase ends with a gate command (`npm test`,
`npm run build`, `npm run test:analyst`) captured to a
`tmp/s10-*.txt` log so that, if a downstream phase regresses an
earlier phase's gate, the per-phase log shows where the
regression entered.

Phase F (ledger drain) and Phase G (refresh baseline) are the
two **mutation** phases against files outside the draft
directory: F edits `expected-breakage-ledger.md`, G overwrites
`baseline-gates.json`. F's paper-plan default is a verified
no-op (the live ledger is header-only with zero OPEN entries —
see below). G commits the new baseline snapshot if the gate
diff against the pre-G baseline is non-empty (i.e. if any
failing_id was repaired). Both pre-images
(`tmp/s10-ledger-before.md`, `tmp/s10-baseline-before.json`)
are captured at Phase A and the deltas are surfaced in the
publication comment for human review.

### REAL-Analyst test discipline

Every analyst playwright scenario, including the eight existing
S1–S8 scenarios and the new fifteen-row coverage matrix
scenarios, drives the **real Analyst** against the
analyst-capable provider that the fixture configures. The
fixture's `bootSaivageServer` call points the saivage-v3 server
at the analyst-capable provider entry in `.saivage/saivage.json`
that the test container ships with; the analyst model id is
**pinned** at fixture-construction time (the fixture writes the
chosen model into the per-test `.saivage/` directory it
provisions, so every scenario sees the same model id and the
same provider configuration). The pinning is the structural
mitigation for the LLM-flakiness risk that MASTER-PLAN-r7 §S10
calls out under "Risk".

There is no offline keyword-fallback path. SPEC-r7 forbids
degraded keyword fallback and S01 removed it from the runtime;
S10's repair work cannot reach for it. If a scenario's
assertion text turns out to depend on a specific
LLM-completion phrasing that varies across runs, the scenario's
assertion is rewritten to assert on the **observable tool-call
sequence and the resulting state-store delta**, never on a
free-text substring of the reply.

If a hermetic CI run requires byte-stable analyst replies (for
example because the test environment cannot reach the
provider's network endpoint), the fixture supports a
**recorded-conversation playback** mode: a per-scenario
recording captured during a known-green live run is replayed
byte-for-byte by a deterministic LLM stub that emits the
recorded tokens in the recorded order. The recording is
re-captured whenever the scenario or the analyst tool surface
changes. This is **not** a keyword parser: the stub emits the
exact stream a real provider emitted in the recorded run, so
the analyst's observable behavior is identical to the live
behavior; the only thing the stub bypasses is the network
round-trip. Phase A.1 documents the fixture's pinned model id
and whether the run is live or playback.

Transient provider errors are surfaced as
**test-infrastructure failures** (5xx-or-timeout responses from
the provider before the analyst can finalize a turn), which the
gate runner classifies as "infra" via the
`reason: 'provider-transient'` field in the per-scenario
metadata. Product failures (a 200 response whose tool-call
sequence or state-store delta fails the scenario assertion) are
the only failures the analyst-e2e gate's `failing_ids` array
records. The fixture's `recordFinding` helper writes the
classification into `findings.md` per scenario.

### S1–S8 repair plan

Each of the eight existing scenarios is repaired so its verdict
moves from LIMITATION to PASS while **its existing scenario
wording and intent are preserved**. The mapping below is
anchored against the live findings file:

- **S1 — Project status (cold start).** Already PASS. Phase
  B.1 is a verification substep; no scenario text changes.
- **S2 — Bootstrap project from short description.** Live
  LIMITATION: the analyst's first call is a `move_card` that
  fails with the apology line "Action 'card.move' requires an
  authorized surface. confirmed/preview_hash confirmation is
  no longer accepted by mutation contracts." This
  `confirmed/preview_hash` apology line is attributed to **S2
  (not S7)** in findings.md. The scenario text — one
  natural-language multi-entity request expressed in a single
  turn — is preserved verbatim. The repair makes the real
  Analyst decompose the single user turn into the required
  sequence of `create_card` calls (project root + research
  card + code card), without ever attempting the retired
  confirmed-flow path. No second user turn is introduced. The
  assertion threshold is "at least two `create_card` calls
  with `result.success: true` across the single user turn".
- **S3 — Pause then resume.** Live LIMITATION: the runtime is
  not initialized when the user asks to pause it, and the
  analyst replies with a generic
  "I'm not sure how to help" rather than initializing the
  runtime first. The scenario's two-turn wording ("Please
  pause the runtime." / "Now resume it.") is preserved. The
  repair makes the real Analyst either (a) bootstrap the
  runtime and then pause-resume, or (b) explain in its reply
  that the runtime needs initialization first and ask for
  permission — both are acceptable PASS shapes; the assertion
  is that at the end of the two turns the runtime ends in the
  state the user asked for (paused after turn 1, resumed
  after turn 2) **or** the analyst recorded a clarification
  turn. The seed fixture is adjusted so the runtime is
  initialized at scenario start (the fixture's
  `seed: 'runtime-initialized'` option), since the scenario
  intent is "pause-then-resume", not "bootstrap-the-runtime".
- **S4 — Edit acceptance criteria via natural language.**
  Live LIMITATION: the analyst calls `get_card` but does not
  follow up with an `update_card`-class write. Scenario
  wording preserved. The repair makes the real Analyst lift
  the quoted phrase out of the user sentence and call the
  surviving acceptance-criteria mutation tool (the exact name
  is whatever the post-S09 registry exposes — verified by
  Phase A.4). Assertion: at least one successful write tool
  invocation whose `params.acceptance` (or analogous field)
  equals the quoted phrase.
- **S5 — Investigate a stuck card.** Live LIMITATION: the
  analyst only fires `get_card` and stops. Scenario wording
  preserved. The repair makes the real Analyst chain the
  surviving investigation surface — `get_card`,
  `read_runtime_errors`, `read_process_log` — into a single
  turn's tool sequence. The retired `list_notes` is **not**
  used; the assertion is "at least three distinct read-only
  investigation tools fired".
- **S6 — Read README and summarise.** Live LIMITATION: the
  analyst's `read_file` call uses a bare `README` path and the
  fixture's tmp-dir layout does not contain that path.
  Scenario wording preserved. The repair makes the real
  Analyst either (a) call `list_files` first to discover the
  README path and then `read_file` it, or (b) call `read_file`
  with a resolved path (`README.md`, `docs/README.md`, etc.).
  The fixture seeds a recognizable README in a discoverable
  location.
- **S7 — Delete all cancelled cards.** Live LIMITATION: the
  analyst attempts a `delete_card`-class write with the
  `target_id` field unset and gets a Zod validation error. The
  `confirmed/preview_hash` apology line does **not** belong to
  S7 — it belongs to S2 per the live findings file. The
  scenario wording "Please delete every card that was
  cancelled" is preserved; the operation under test is **real
  delete**, not archive. The repair makes the real Analyst
  call `list_cards(filter: { status: 'cancelled' })`,
  enumerate the matching ids, then call
  `delete_card(target_id: <id>)` once per match. Assertion:
  "after the turn, no card with `status: 'cancelled'` exists,
  and the cards-store has shrunk by exactly the count of
  pre-turn cancelled cards". The destructive verb passes
  through the conversational confirmation flow if the
  post-S09 registry requires it; the affirm response is part
  of the same user turn.
- **S8 — Multi-turn clarification.** Live LIMITATION: the
  analyst's first turn calls `create_card` with a project
  type that already exists (the fixture pre-seeds a project)
  and the second turn calls `create_card` with no title or
  description — neither turn elicits a clarification. The
  scenario wording (two user turns: vague request, then
  refined request) is preserved as a **multi-turn
  clarification** scenario, **not** a deictic/workspace-
  context test (deictic resolution is row 3 of the new matrix
  and is independent). The repair makes the real Analyst (a)
  detect the missing information on turn 1 ("a new project"
  is ambiguous: name, scope, first card) and emit a
  clarification turn that asks one question, **then** (b) on
  the user's turn-2 reply ("training a small chess model.
  Please go ahead and create the project card and a first
  research card.") emit the corresponding `create_card`
  sequence with non-empty `title` and `description` fields.
  This repair is satisfied by S01's clarification semantics
  combined with S08's deictic / workspace-context window: the
  clarification semantics drive turn 1's "ask one question"
  behavior; the workspace-context window carries the turn-1
  reference forward so the turn-2 reply binds correctly. The
  assertion is: turn 1 fires zero write tools and the
  assistant reply contains a question mark followed by a
  clarification phrase; turn 2 fires at least two
  `create_card` calls (project + research) with non-empty
  required fields.

If a per-scenario repair turns out to require source-tree
behavior that did NOT ship in S01 through S09 (for example,
the post-S09 registry lacks the tool the repair needs), the
repair cannot land in S10 and the scenario stays LIMITATION;
S10 escalates by opening `011-<slug>` per the protocol below,
and the follow-up stage owns the source change that makes the
scenario PASS. S10 NEVER rewrites the scenario premise to
sidestep the missing capability.

### 15-row coverage matrix

Phase C authors new analyst playwright scenarios covering every
row of the MASTER-PLAN-r7 §S10 "Required new test coverage"
matrix. The rows are reproduced below with the scenario-id
ranges Phase C uses; each row has one or more scenarios in
`scenarios.spec.js`, and each scenario id appears as a discrete
substep in `plan.md` Phase C and a row in `## Test plan` of
this file.

| Row | Topic | Scenario ids | What the scenarios prove |
| --- | --- | --- | --- |
| 1 | Inspect inventory | S9 (cards/history), S10 (runtime state/events/errors), S11 (audit log), S12 (agent transcripts), S13 (process registry/output), S14 (directory listings), S15 (file contents) | One scenario per inspect category fires the read-only tool that surfaces that category and asserts the analyst's reply renders the seeded fixture content. |
| 2 | Non-secret inspection boundary | S16 (provider API key in `.saivage/saivage.json`), S17 (full `.saivage/auth-profiles.json`), S18 (runtime token in a process output dump), S19 (env-var-flagged secret) | Each scenario seeds a secret-bearing artifact alongside a sibling non-secret artifact, asks the analyst to read the secret artifact, and asserts (a) the assistant reply does not contain any secret value (regex sweep over the response body and tool-result payloads), and (b) the audit log records a redaction decision (`redacted: true` field or analogous). The sibling non-secret artifact is also read and its content is allowed through. |
| 3 | Analyst-driven navigation, deictic resolution, "go back" | S20 (navigate to a card by name, then `navigate_back`), S21 (deictic "this card" with workspace-context bound to a card) | S20 asserts `navigate_workspace` + `navigate_back` fire and the rendered route effect follows the navigation intent then returns to the prior route. The route effect is observed via `page.url()` plus a per-view DOM locator on the rendered post-S08 chat/card views; no internal Pinia state is read. S21 asserts `get_card` fires with the workspace-context-bound id without any clarification turn. |
| 4 | General non-deictic ambiguity, one-clarification rule | S22 | An ambiguous request that does NOT use a deictic ("Set up that report we discussed" without any prior context). The assistant reply contains exactly one clarifying question; no write tool fires until the user replies; on the user reply the corresponding write tool fires. |
| 5 | One-turn batch/set card mutation | S23 ("Please delete every cancelled card under goal-7") | A single user turn drives the analyst through `list_cards(parent: goal-7, status: cancelled)` then a loop of `delete_card(target_id: <id>)`. Assertion: at end of turn, zero cards remain under goal-7 with status `cancelled`. |
| 6 | Bounded move both directions, refusals, child reorder | S24 (move up within siblings), S25 (move down within siblings), S26 (cross-tree refusal), S27 (root-card refusal), S28 (child reorder distinct from move) | Five sub-scenarios, each a single user turn. The two accept sub-scenarios call `move_card` with `result.success: true`; the two refusal sub-scenarios get `result.success: false` with the refusal-reason field set; the reorder sub-scenario calls `reorder_children` and asserts the post-state child sequence. |
| 7 | Ordered-child rendering matrix, seven §4.1 UI surfaces | S29 (cards tree), S30 (card detail view), S31 (card history child references), S32 (dashboard child-of-goal panels), S33 (files view card-bound child listings), S34 (debug view child lists), S35 (analyst chat context lists) | Each scenario fixtures a shuffled `position` vector for its surface's child collection, navigates to the surface, and asserts via the playwright DOM probe that the rendered list order matches the `position` field. All seven surfaces are exercised end-to-end; the analyst-chat-context-list e2e (S35) is the substantive S10 contribution and is not substituted by any pre-existing vitest. |
| 8 | Notification queue round-trip via existing audit-log + planner-conversation routes; follow-up retraction; absence of list/get/ack analyst tools | S36 | One scenario, three sub-assertions: (a) call `queue_notification` to enqueue a reminder; (b) observe the queued reminder via two complementary read-only surfaces that already exist — `GET /api/control-actions` (audit-log entry for the `queue_notification` action) and `GET /api/agents/:id/conversation` for the planner session (delivery message for the same body) — and assert both surfaces show the queued reminder; (c) retract the notification via a follow-up analyst turn ("never mind, drop that reminder") and assert the same two surfaces show the retraction (audit log records the retraction action; planner conversation records the retraction delivery or withdrawal). The scenario also imports `ANALYST_TOOL_NAMES` from the compiled `src/agents/analyst-tool-schemas.ts` module (via the `analystToolRegistry()` fixture helper) and asserts no entry matches `list_notifications`, `get_notification`, `acknowledge_notification`, or any `ack`-named tool. No `/api/planner-session/:id` or `/api/analyst/tools` route is referenced; all observation surfaces are already present in the post-S09 product. |
| 9 | Full runtime-control verb coverage + destructive confirmation | S37 (start), S38 (stop), S39 (pause), S40 (resume), S41 (abort goal subtree), S42 (restart card or subtree), S43 (mark goal as needing corrections), S44 (terminate process), S45 (destructive verb affirm), S46 (destructive verb cancel), S47 (destructive verb amend), S48 (destructive verb stale) | Eight verb-coverage scenarios each issue the named runtime-control verb in a single turn and assert the runtime state-store delta the verb is supposed to produce. Four confirmation-flow scenarios each issue a destructive verb (delete-class or abort-class) and exercise the affirm / cancel / amend / stale-timeout responses; each asserts the corresponding audit-log shape. |
| 10 | Full reconfigure suite | S49 (role/model routing), S50 (failover order), S51 (MCP entry add), S52 (MCP entry edit), S53 (MCP entry remove), S54 (runtime setting), S55 (server setting), S56 (restart-server-when-required prompt), S57 (redacted `show_config`) | Nine sub-scenarios. Each calls the analyst's `reconfigure`-family tool with the row-specific intent and asserts (a) the call succeeds, (b) the `.saivage/saivage.json` (or analogous config) reflects the change, and (c) the audit log records the reconfiguration. S57 asserts `show_config`'s output redacts every provider-secret-shaped field. |
| 11 | Investigate-and-repair + apply-fix follow-up + partial-success | S58 (investigate-and-repair narrative), S59 ("apply that fix" follow-up), S60 (partial-success multi-step) | S58 chains the read-only investigation tools and asks the analyst to propose a fix. S59 issues "apply that fix" as a follow-up turn and asserts the corresponding write tool fires. S60 issues a multi-step repair request and asserts that when one of the steps fails, the analyst reports partial success with per-step status. |
| 12 | Failure modes | S61 (provider offline — no mutation, explicit phrase), S62 (unsupported action reply), S63 (unknown internal capability reply), S64 (stale destructive confirmation) | S61 simulates a provider-offline condition via the fixture and asserts the analyst's reply contains the explicit "provider offline" phrase and no mutation fires. S62 asks for an action the analyst cannot perform and asserts the unsupported-action reply. S63 asks for an internal capability the analyst is not exposed to and asserts the unknown-capability reply. S64 issues a destructive verb, waits past the confirmation TTL, and asserts the stale-confirmation rejection. |
| 13 | Read-only affordance preservation | S65 | One large scenario that drives the playwright page through every read-only affordance the master-plan bullet names: refresh, filter, sort, search, expand/collapse, copy-to-clipboard, and navigation across cards, dashboard, files, agents, and debug. Each affordance is exercised end-to-end with a DOM-state assertion. |
| 14 | Bootstrap boundary | S66 (no analyst-capable provider configured), S67 (at least one analyst-capable provider configured) | Two sub-scenarios. S66 boots a server whose `.saivage/saivage.json` lists no analyst-capable provider and asserts the bootstrap boundary holds (the analyst panel surfaces the bootstrap prompt; analyst chat is disabled). S67 boots a server with one configured and asserts the analyst is usable and the bootstrap prompt is absent. |
| 15 | Audit actor + originating-surface | S68 | One scenario that issues a representative set of mutations (one card mutation, one runtime control, one reconfigure, one `queue_notification`) and then asks the analyst to surface the corresponding audit entries by driving the `read_control_actions` analyst tool (declared in `src/agents/analyst-tool-schemas.ts`), cross-checked via `GET /api/control-actions` from the test fixture. The assertion checks each entry's `actor` field equals `'analyst'` and the originating-surface field is set to the SPEC-r7-specified value. |

Each scenario is a single `test('S<N>: ...', ...)` block in
`saivage-e2e-checkers/e2e/analyst/scenarios.spec.js`. The
`recordFinding(...)` helper writes the verdict into `findings.md`
exactly as S1–S8 do; the verdict-classification thresholds
follow the same shape (any tool-call sequence mismatch or
state-store-delta mismatch yields `LIMITATION`; an
expected-tool sequence with the expected state delta yields
`PASS`).

### Ordered-child rendering matrix — the seven §4.1 surfaces

Per MASTER-PLAN-r7 §4.1 the seven UI surfaces that S10 must
prove render children in `position` order are:

1. **Cards tree** — the workspace area card-tree list rendered
   by `CardsView.vue`. S29 fixtures a shuffled `position`
   vector on a parent card's children and asserts the cards
   tree's rendered DOM order matches `position`.
2. **Card detail view** — the child-list block inside a card
   detail panel rendered by `CardDetailView.vue`. S30
   fixtures and asserts as in S29.
3. **Card history child references** — the
   `CardHistoryPanel.vue` (or analogous) child-reference block
   that lists historic children of a card. S31 fixtures a
   shuffled `position` vector on the history's child
   references and asserts the rendered DOM order.
4. **Dashboard child-of-goal panels** — the dashboard surfaces
   that list children of a goal card. S32 fixtures and
   asserts.
5. **Files view card-bound child listings** — the files view
   surfaces that list children of a card-bound file group.
   S33 fixtures and asserts.
6. **Debug view child lists** — the debug view's child lists
   under a parent debug entity. S34 fixtures and asserts.
7. **Analyst chat context lists** — the "On screen" children
   block in `AnalystChatPanel.vue`. **S35 fixtures and asserts
   end-to-end via the playwright DOM probe.** S08's
   `AnalystChatPanel.children.test.ts` vitest is unit
   coverage and does **not** substitute for the analyst-chat
   e2e row; S35 is authored regardless.

All seven scenarios are appended to the playwright suite in
Phase C (S29 through S35). No vitest is added for any of the
seven; all coverage is end-to-end through the playwright surface.

### Test file deletion inventory

Phase D removes the following files from disk via `git rm` (or
`rm` followed by `git add -A` if the file is not tracked). The
list is computed by Phase A.2 against the post-S09 source tree;
the entries below are the paper-plan default determined by the
master-plan §S04, §S06, §S07, §S09 scope statements:

**`saivage-v3/tests/` — jest unit/integration:**

- `tests/utils/runtime-queue-notification.test.ts` if it still
  exists (S04 retired the `runtime.queue_notification`
  operator path; the analyst side survives and is covered by
  Phase E.1's repair of
  `tests/integration/queue-notification-roundtrip.test.ts`).
  Paper-plan default: already removed by S04; conditional
  no-op.
- `tests/utils/operator-chat-control.test.ts` if it still
  exists (S05 retired the operator-chat-host control verbs).
  Paper-plan default: conditional no-op.

**`saivage-v3/web/src/__tests__/` — vitest:**

The post-S06 vitest tree no longer contains tests for the
retired mutation widgets, per S06's H phase. Phase A.2
enumerates `web/src/__tests__/components/`; any candidate
file (`AddNoteForm.test.ts`, `MarkHandledButton.test.ts`,
`MoveCardModal.test.ts`, etc.) is removed only if still
present. Paper-plan default: empty set.

**`saivage-e2e-checkers/e2e/` — playwright:**

No file deletion. The single `scenarios.spec.js` is edited in
place by Phase B (repair S1–S8) and Phase C (append the new
scenarios). The `findings/findings.md` file is regenerated by
each test run; the pre-S10 file is preserved as
`tmp/s10-findings-before.md` by Phase A.5.

### Test file repair inventory

Phase E rewrites or repairs the following files; none are
deleted:

- `tests/integration/runtime-redesign-golden.test.ts` —
  Phase E.5 hex-escape rewrite of any retired-token guard
  regex.
- `tests/server/operator-api-contracts.test.ts` — Phase E.6
  hex-escape rewrite of the operator-API negative-assertion
  regex.
- `tests/agents/agent-adapter-non-planner-tools.test.ts` and
  `tests/agents/analyst-tool-surface.test.ts` — Phase E.4
  hex-escape rewrite of retired-tool guard assertions; the
  `RETIRED_NOTE_TOOLS` constant declared at the top of each
  file holds the three forbidden tokens (`list_notes`,
  `mark_note_handled`) hex-escaped and `add_note`, `get_note`
  literal.
- `tests/agents/agent-adapter-force-final-answer.test.ts` —
  Phase E.3 renames the fake tool name `list_notes` used as
  a fixture-only repeat-trigger to a synthetic
  non-forbidden name (`__synthetic_repeat_tool`); semantics
  preserved.
- `tests/utils/control-action-audit.test.ts`,
  `tests/utils/runtime-project-planner-control-flow.test.ts`,
  `tests/agents/analyst-tool-runner.test.ts`,
  `tests/analyst.test.ts` — Phase E.7 audit of every
  occurrence of `confirmed` per the H.10b inspection rule
  (see "`confirmed` audit (H.10b)" below). Rewrite to
  post-S05 vocabulary where the occurrence describes the
  retired confirmation flow; leave untouched where it is
  canonical post-S09 vocabulary.

### Preserving negative-assertion guards

Several surviving tests assert the **absence** of a forbidden
token from a target string (the API surface, a documentation
file, a renderable view). These are load-bearing — removing
them would let the retired vocabulary silently regress. The
**hex-escape pattern** preserves the test semantics while
keeping the literal forbidden tokens out of the test source:

```ts
// before:
expect(JSON.stringify(operatorApiContracts)).not.toMatch(/preview_hash|list_notes/);

// after:
const RETIRED_TOKENS = [
  '\x70review_\x68ash',  // preview_hash, hex-escaped
  '\x6cist_notes',       // list_notes, hex-escaped
];
const retiredRegex = new RegExp(RETIRED_TOKENS.join('|'));
expect(JSON.stringify(operatorApiContracts)).not.toMatch(retiredRegex);
```

The compiled regex at test runtime is identical to the
original; the H.10 grep over the test source does not match
because no contiguous occurrence of the literal token exists
in the source file.

### `confirmed` audit (H.10b)

The H.10 forbidden-token grep is a strict zero-hit check for
the three master-plan tokens
`mark_note_handled|list_notes|preview_hash` ONLY. The
`confirmed` token is handled separately because it is
overloaded: some occurrences describe the retired confirmation
flow (the deprecated `confirmed: true` body field), others are
canonical post-S09 vocabulary (audit-event names such as
`control.action_confirmed_by_analyst`, plain-English assertion
messages describing operator confirmation behavior).

Phase H.10b surfaces every `\bconfirmed\b` hit across the
charter-specified trees (`saivage-v3/tests`,
`saivage-v3/web/src/__tests__`, `saivage-e2e-checkers`) and
requires the implementer to **inspect each hit manually**. For
every hit the implementer records one of three classifications:

- **(a)** describes the retired confirmation flow — REWRITE to
  post-S05 vocabulary in Phase E.
- **(b)** load-bearing negative-assertion guard — HEX-ESCAPE
  via the `RETIRED_TOKENS`-style constant.
- **(c)** canonical post-S09 vocabulary (audit-event name,
  plain-English message) — LEAVE UNTOUCHED and record the
  exemption.

The H.10b substep is **not** a zero-hit gate; it is a
manual-inspection gate. It passes when every hit has a recorded
classification and every (a) and (b) classification has been
applied. The classifications are recorded in
`tmp/s10-confirmed-audit.txt` with one line per hit:
`<file>:<line>: bucket=<a|b|c> action=<rewrite|hex-escape|exempt>`.

### Forbidden-token gate scope (H.10)

The H.10 strict-grep scope is the **absolute paths** the
charter names:

- `saivage-v3/tests`
- `saivage-v3/web/src/__tests__`
- `saivage-e2e-checkers`

The grep is run from the workspace root (one directory above
the saivage-v3/ working directory) so all three paths resolve
unambiguously. The substep does not use a relative
`../saivage-e2e-checkers/e2e/`-style scope; the full
`saivage-e2e-checkers` tree is searched (including its
`fixtures/` and `findings/` subdirectories) so a forbidden
token cannot hide under a non-`e2e/` subdirectory.

### Findings file regeneration

`saivage-e2e-checkers/e2e/analyst/findings/findings.md` is not
a stable source file — the playwright `beforeAll` hook in
`scenarios.spec.js` rewrites it on every run with the
`Run: <timestamp>` header. The pre-S10 file is captured by
Phase A.5 to `tmp/s10-findings-before.md` for diff purposes.
After Phase B + Phase C + Phase H.9, the file's contents
reflect the new verdicts.

### Ledger drain plan (live state)

The live state of
[`expected-breakage-ledger.md`](../../expected-breakage-ledger.md)
at S10 read time is **header-only with zero OPEN entries**:
the file contains the entry-shape header and the
`## Open entries` section header, and no `### ` H3 entry
follows. Phase F's task is therefore to **re-verify** the zero
OPEN-entry condition and to assert the empty-ledger close gate
H.4. There is no entry to drain in the paper-plan default;
Phase F.1 is a verified no-op.

If, when S10 is implemented in a different filesystem state,
the ledger is non-empty (because an earlier stage's
implementation rolled forward and added entries), Phase F
drains each OPEN entry per its `Target fix stage`:

- For each entry, verify the corresponding failing id is no
  longer observed by the post-Phase-E source (via the
  Phase F.2 gate snapshot).
- If the failing id is repaired, remove the entry's H3 block
  from the ledger via an in-place edit.
- If the failing id is **not** repaired, the entry is
  un-repairable in-stage. Phase H.11 escalation engages per
  the rule below; S10 cannot close. The un-repairable entry
  is owned by the `011-<slug>` follow-up.

S10's own close-out **never appends** ledger entries.

### Un-repairable failures and follow-up escalation

If any failure at S10 cannot be repaired in-stage — whether a
gate is reporting a NEW failing id at Phase H, a forbidden
token survives Phase E, an OPEN ledger entry resists Phase F
drain, or a baseline refresh cannot reach `failing_ids: []` —
S10 cannot close. The correct response is:

1. Capture the surviving condition per gate / per entry to
   `tmp/s10-unrepairable.txt`.
2. Open a follow-up stage at the next free NNN-prefix
   directory (`011-<slug>/` at S10-close time) per
   MASTER-PLAN-r7 §7. The slug describes the substantive
   failure category. The follow-up stage's `design.md` and
   `plan.md` are authored in the same writer-reviewer
   protocol as any other stage.
3. **The follow-up stage takes ownership.** Any ledger entry
   authored as part of the escalation is authored as part of
   the follow-up stage's close-out, lives in the follow-up
   stage's evidence trail, and names `S11` (the published id
   of the follow-up stage) as `Target fix stage`. **S10's own
   close-out does not append the ledger entry.**
4. The S10 draft directory remains in `drafts/`; the atomic
   publish (`mv` to `stages/`) is skipped. S10 is
   re-attempted once `011-<slug>` is published, possibly in a
   separate session by a different agent.

This escalation is the only S10-specific deviation from the
generic Phase H close-out used by S00 through S09. S10's H.11
is **inverted** relative to S00–S09: where the earlier stages
conditionally append OPEN entries with a later target stage as
part of their normal close-out, S10's H.11 either confirms a
clean close (paper-plan default) or triggers the escalation
above. **S10 never appends ledger entries naming S11 as
their target fix stage from inside its own close-out; any
such OPEN entry, if needed, is authored by the follow-up
`011-<slug>` stage.**

## Surfaces touched

- **Analyst e2e (playwright):**
  - `saivage-e2e-checkers/e2e/analyst/scenarios.spec.js` —
    edit S1 through S8 to deterministic-PASS verdicts; append
    the new scenarios per the 15-row coverage matrix
    (S9 onward).
  - `saivage-e2e-checkers/e2e/analyst/fixtures/saivage-server.js`
    — add helper exports (`controlActionsLog`,
    `plannerSessionInspect`, `analystToolRegistry`,
    `workspaceRouteSnapshot`) used by the new scenarios. Each
    helper binds to a read-only surface that ALREADY exists in
    the post-S09 product (`GET /api/control-actions`,
    `GET /api/agents/:id/conversation`, the compiled
    `dist/src/agents/analyst-tool-schemas.js` module's
    `ANALYST_TOOL_NAMES` export, and `page.url()` plus
    rendered-DOM probes for the route snapshot). The
    `analystToolRegistry()` helper dynamic-imports the compiled
    registry from the peer saivage-v3 `dist/src/agents/`
    output; the live `tsconfig.json` sets `outDir: dist` and
    `rootDir: .`, so source files under `src/` emit to
    `dist/src/` and the verified path from the fixture
    directory `saivage-e2e-checkers/e2e/analyst/fixtures/` is
    `../../../../saivage-v3/dist/src/agents/analyst-tool-schemas.js`.
    The fixture therefore DEPENDS on the `tsc-build` gate
    (H.5: `npx tsc -p .` from `saivage-v3/`) having produced
    that compiled output before the `analyst-e2e` gate (H.9)
    runs; the H.5 → H.9 ordering in the Phase H close-out
    enforces this dependency. No existing export is renamed or
    removed and no new product route or global app-state hook
    is introduced.
  - `saivage-e2e-checkers/e2e/analyst/findings/findings.md`
    — regenerated by the next test run.
- **Jest unit/integration (saivage-v3):**
  - `tests/integration/runtime-redesign-golden.test.ts` —
    Phase E.5 hex-escape rewrite.
  - `tests/server/operator-api-contracts.test.ts` —
    Phase E.6 hex-escape rewrite.
  - `tests/agents/agent-adapter-non-planner-tools.test.ts` —
    Phase E.4 hex-escape rewrite.
  - `tests/agents/agent-adapter-force-final-answer.test.ts` —
    Phase E.3 fixture-name rename.
  - `tests/agents/analyst-tool-surface.test.ts` — Phase E.4
    hex-escape rewrite.
  - `tests/utils/control-action-audit.test.ts`,
    `tests/utils/runtime-project-planner-control-flow.test.ts`,
    `tests/agents/analyst-tool-runner.test.ts`,
    `tests/analyst.test.ts` — Phase E.7 per-occurrence audit
    of `confirmed` per H.10b.
- **Vitest (saivage-v3/web):**
  - No new vitest files. The ordered-child rendering matrix
    is covered entirely by analyst playwright scenarios per
    "Approach → Ordered-child rendering matrix" above.
  - `web/src/__tests__/read-only-positive-checklist.test.ts`
    — left untouched in the paper-plan default; if Phase A.2
    surfaces a render surface not on the checklist, one
    regex line per new surface is appended.
- **Test file deletions** — computed at Phase A.2; paper-plan
  default is conditional no-op.
- **Reconciliation files (outside the draft directory):**
  - `SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`
    — Phase F re-verifies zero OPEN entries (paper-plan
    default: header-only).
  - `SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`
    — Phase G regenerates via `run-gates.sh --baseline`.
- **NOT TOUCHED:**
  - Any source file under `saivage-v3/src/`.
  - Any source file under `saivage-v3/web/src/` outside of
    `web/src/__tests__/`.
  - `SPEC/analyst-as-control-surface/SPEC-r7.md`,
    `00-MASTER-PLAN-r7.md`, `02-PROTOCOL-r4.md`,
    `VALIDATION-COOKBOOK.md`, `forbidden-anchors.txt`.
  - Any published stage directory under `stages/`.

## Test plan

S10 is itself a test-suite update stage. The plan below
describes how the **modified test suites** are exercised at
close-out (Phase H), and it lists every new scenario id with a
one-sentence description, in one-to-one correspondence with
the discrete substeps in `plan.md` Phase C.

### Gate command summary

| Gate | Command (run from saivage-v3/) | Required outcome |
| --- | --- | --- |
| `analyst-e2e` | `( cd ../saivage-e2e-checkers && npm run test:analyst -- --reporter=json --output=../tmp/playwright-analyst-report.json )` | Exit 0; every spec records `outcome: 'expected'`; `findings.md` records PASS for every scenario. |
| `web-vitest` | `( cd web && npx vitest run --reporter=json --outputFile=../../tmp/web-vitest-report.json )` | Exit 0; zero failing assertionResults. The eight S00 pre-recorded failing ids are REPAIRED. |
| `tsc-build` | `npx tsc -p .` | Exit 0; zero `error TS<code>` diagnostics. |
| `web-vite-build` | `( cd web && npm run build )` | Exit 0; zero vue-tsc or rollup errors. |
| Gate diff | `bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` | Pre-G: zero NEW; REPAIRED on `web-vitest` includes the eight S00 ids. Post-G: zero NEW, zero REPAIRED. |
| H.10 strict grep | See `plan.md` Phase H step H.10 for the runnable close-out command. | Zero hits; grep's own exit status drives the branch, so the gate is reliable without `set -o pipefail`. |
| H.10b `confirmed` audit | `( cd .. && grep -REnw -- 'confirmed' saivage-v3/tests saivage-v3/web/src/__tests__ saivage-e2e-checkers \| tee tmp/s10-confirmed-hits.txt )` | Every hit is recorded in `tmp/s10-confirmed-audit.txt` with a (a)/(b)/(c) classification per "Approach → `confirmed` audit (H.10b)". |

### Per-scenario test rows

The scenario rows below cover the eight repaired scenarios and
the new 15-row coverage matrix. Every row maps to a discrete
substep in `plan.md` Phase B or Phase C.

| Scenario | Plan substep | Row | Description |
| --- | --- | --- | --- |
| S1 | B.1 | repair | Verify project-status cold-start scenario remains PASS. |
| S2 | B.2 | repair | One natural-language multi-entity request decomposed into the create_card sequence; preserve single-turn wording. |
| S3 | B.3 | repair | Two-turn pause-then-resume against a runtime-initialized seed. |
| S4 | B.4 | repair | Edit acceptance criteria via the surviving acceptance-mutation tool. |
| S5 | B.5 | repair | Investigation chain `get_card` + `read_runtime_errors` + `read_process_log`. |
| S6 | B.6 | repair | Read README and summarize after path discovery. |
| S7 | B.7 | repair | Delete every cancelled card (real delete, not archive) via list_cards + delete_card loop. |
| S8 | B.8 | repair | Multi-turn clarification: turn 1 emits a clarification question; turn 2 creates the project + research card. |
| S9 | C.1 | 1 | Inspect inventory — cards / card history category. |
| S10 | C.2 | 1 | Inspect inventory — runtime state / events / errors category. |
| S11 | C.3 | 1 | Inspect inventory — audit log category. |
| S12 | C.4 | 1 | Inspect inventory — agent transcripts category. |
| S13 | C.5 | 1 | Inspect inventory — process registry / output category. |
| S14 | C.6 | 1 | Inspect inventory — directory listings category. |
| S15 | C.7 | 1 | Inspect inventory — file contents category. |
| S16 | C.8 | 2 | Non-secret boundary — provider API key in `.saivage/saivage.json`. |
| S17 | C.9 | 2 | Non-secret boundary — full `.saivage/auth-profiles.json`. |
| S18 | C.10 | 2 | Non-secret boundary — runtime token in process output. |
| S19 | C.11 | 2 | Non-secret boundary — env-var-flagged secret. |
| S20 | C.12 | 3 | Navigate to a card by name, then `navigate_back`. |
| S21 | C.13 | 3 | Deictic resolution — "this card" with workspace-context bound to a card. |
| S22 | C.14 | 4 | General non-deictic ambiguity — one-clarification-question rule. |
| S23 | C.15 | 5 | One-turn batch/set mutation — delete every cancelled card under goal-7. |
| S24 | C.16 | 6 | Bounded move up within siblings (accept). |
| S25 | C.17 | 6 | Bounded move down within siblings (accept). |
| S26 | C.18 | 6 | Bounded move cross-tree (refuse). |
| S27 | C.19 | 6 | Bounded move of root card (refuse). |
| S28 | C.20 | 6 | Child reorder distinct from move. |
| S29 | C.21 | 7 | Ordered-child rendering — cards tree surface. |
| S30 | C.22 | 7 | Ordered-child rendering — card detail view surface. |
| S31 | C.23 | 7 | Ordered-child rendering — card history child references surface. |
| S32 | C.24 | 7 | Ordered-child rendering — dashboard child-of-goal panels surface. |
| S33 | C.25 | 7 | Ordered-child rendering — files view card-bound child listings surface. |
| S34 | C.26 | 7 | Ordered-child rendering — debug view child lists surface. |
| S35 | C.27 | 7 | Ordered-child rendering — analyst chat context lists surface (e2e, not vitest). |
| S36 | C.28 | 8 | Notification queue round-trip via `GET /api/control-actions` + `GET /api/agents/:id/conversation`; retraction follow-up via the same two surfaces; absence of list/get/ack analyst tools asserted against `ANALYST_TOOL_NAMES`. |
| S37 | C.29 | 9 | Runtime verb — start. |
| S38 | C.30 | 9 | Runtime verb — stop. |
| S39 | C.31 | 9 | Runtime verb — pause. |
| S40 | C.32 | 9 | Runtime verb — resume. |
| S41 | C.33 | 9 | Runtime verb — abort goal subtree. |
| S42 | C.34 | 9 | Runtime verb — restart card or subtree. |
| S43 | C.35 | 9 | Runtime verb — mark goal as needing corrections. |
| S44 | C.36 | 9 | Runtime verb — terminate process. |
| S45 | C.37 | 9 | Destructive verb confirmation — affirm. |
| S46 | C.38 | 9 | Destructive verb confirmation — cancel. |
| S47 | C.39 | 9 | Destructive verb confirmation — amend. |
| S48 | C.40 | 9 | Destructive verb confirmation — stale (TTL-expired). |
| S49 | C.41 | 10 | Reconfigure — role/model routing. |
| S50 | C.42 | 10 | Reconfigure — failover order. |
| S51 | C.43 | 10 | Reconfigure — MCP entry add. |
| S52 | C.44 | 10 | Reconfigure — MCP entry edit. |
| S53 | C.45 | 10 | Reconfigure — MCP entry remove. |
| S54 | C.46 | 10 | Reconfigure — runtime setting. |
| S55 | C.47 | 10 | Reconfigure — server setting. |
| S56 | C.48 | 10 | Reconfigure — restart-server-when-required prompt. |
| S57 | C.49 | 10 | Reconfigure — redacted `show_config`. |
| S58 | C.50 | 11 | Investigate-and-repair narrative. |
| S59 | C.51 | 11 | "Apply that fix" follow-up turn. |
| S60 | C.52 | 11 | Partial-success multi-step repair. |
| S61 | C.53 | 12 | Failure mode — provider offline (no mutation, explicit phrase). |
| S62 | C.54 | 12 | Failure mode — unsupported action reply. |
| S63 | C.55 | 12 | Failure mode — unknown internal capability reply. |
| S64 | C.56 | 12 | Failure mode — stale destructive confirmation. |
| S65 | C.57 | 13 | Read-only affordance preservation — refresh, filter, sort, search, expand/collapse, copy-to-clipboard, navigation across cards/dashboard/files/agents/debug. |
| S66 | C.58 | 14 | Bootstrap boundary — no analyst-capable provider configured. |
| S67 | C.59 | 14 | Bootstrap boundary — at least one analyst-capable provider configured. |
| S68 | C.60 | 15 | Audit `actor='analyst'` + originating-surface field. |

## Expected breakage forecast

Per MASTER-PLAN-r7 §3-(5) and §3-(8), S10 is the **terminal
stage** of the eleven-stage plan and is **forbidden** to append
any forecast that targets a stage that does not exist in the
master plan. **S10's own close-out never appends ledger
entries.** The only legitimate ledger entry that can arise from
S10 work is one authored as part of a `011-<slug>` follow-up
stage's close-out, which targets `S11` (the published id of
that follow-up stage) and lives in the follow-up stage's
evidence trail — not in S10's.

The paper-plan default forecast is therefore:

- **Zero new OPEN ledger entries** appended by S10.
- **Zero existing OPEN entries** drained by Phase F.1 — the
  live ledger is already header-only with zero OPEN entries at
  S10 read time, so Phase F.1 is a verified no-op.
- **Zero un-repairable gate failings** at Phase H close-out.
  If any arise, the escalation protocol in
  "Approach → Un-repairable failures and follow-up
  escalation" engages: the draft remains in `drafts/`, a
  `011-<slug>` follow-up is opened, and any ledger entry that
  the escalation produces is authored by the follow-up stage's
  own close-out.

The S10 close-out **inverts** the per-stage forecast model
used by S00 through S09: S10 cannot push breakage forward to a
later stage in the master plan, so S10 is structurally the
**empty-ledger close gate**, not a ledger appender. This
inversion is the substantive reason S10 exists as a distinct
stage rather than being folded into S09.

## Done-definition cross-reference

S10 acceptance maps to the following items in
[`stages/000-breakage-detection-harness/plan.md`](../../stages/000-breakage-detection-harness/plan.md)
done-definition matrix:

- **V.1** — `baseline-gates.json` exists and
  `jq -e .schema_version == 1` passes. Phase G regenerates
  the file via `run-gates.sh --baseline`, which writes the
  schema_version field.
- **V.2** — Every gate id in `baseline-gates.json` matches the
  cookbook's four-gate list. S10 preserves the gate id list;
  no gate is added or removed.
- **V.3** — Every gate's `failing_ids` is an array. After
  Phase G, every array is empty.
- **V.4** — The cumulative ledger's `## Open entries` section
  header exists and the section contains zero `### ` H3
  headings. Phase F re-verifies this state; H.4 is the close
  gate.
- **V.5** — `forbidden-anchors.txt` is unchanged from S00;
  S10 does not edit it.
- **V.6** — The validation cookbook is unchanged.
- **V.7** — The `run-gates.sh` driver is unchanged; S10
  invokes it from Phase G.3 in `--baseline` mode and from
  Phase H.12 in `--diff` mode.
- **V.8** — `check-stage-links.sh` is invoked from Phase H.13
  against the draft directory; required outcome exit 0.
- **V.9** — The publication ceremony (atomic mv) follows the
  S00–S09 shape; Phase H.14.
- **V.10** — VALIDATION-COOKBOOK §9 activation preflight is
  respected by the playwright fixture during Phase H.9.
- **V.11** — Every OPEN ledger entry's `Target fix stage`
  field references an existing stage id; S10's Phase F.1
  drain (paper-plan default: verified no-op) leaves the
  ledger header-only, and S10's H.11 does not append any new
  entry.

S10 acceptance also maps to the SPEC-r7 acceptance clauses
named in the 15-row coverage matrix and to the
MASTER-PLAN-r7 §S10 "Required new test coverage" matrix
verbatim.

## Downstream impact

S10 is the terminal stage; no downstream stage exists in the
master plan. The downstream impact is **operational, not
architectural**:

- After S10 publishes, the post-S10 source tree is the
  **stable baseline** for any further work on the
  analyst-as-control-surface migration. Subsequent
  improvements (UX polish, additional analyst tools,
  additional inspection surfaces) are introduced via fresh
  stages authored against this baseline; the post-S10
  baseline snapshot is the reference snapshot they diff
  against.
- After S10 publishes, the cumulative ledger remains the
  open-entries log for any future work; new stages may
  append entries again under the same MASTER-PLAN-r7 rules.
  The S10 close does not permanently retire the ledger.
- After S10 publishes, the four S00 gates remain the
  authoritative breakage-detection harness. No gate id is
  retired and the cookbook's command catalogue is the
  permanent reference.
- The escalation-stage `011-<slug>` (if opened) is the only
  structural new artifact S10 can create downstream; per
  MASTER-PLAN-r7 §7 it lives at the next free NNN prefix and
  is named after its substantive failure category.
- The four currently-published containers (`saivage` at
  10.0.3.111, `saivage-v3` at 10.0.3.112,
  `saivage-v3-getrich-v2` at 10.0.3.170, `diedrico` at
  10.0.3.113) consume the post-S10 source through their bind
  mounts; no container redeploy is part of S10's scope, but
  the post-S10 source is the source the next redeploy will
  pick up. The VALIDATION-COOKBOOK §9 activation preflight
  governs that redeploy and is not S10's responsibility to
  gate.

## Open issues

- The paper-plan default for the eight pre-recorded
  `web-vitest` failing ids in `baseline-gates.json` is that
  the post-S09 source has them all repaired. Phase A.3
  empirically enumerates each one against the post-S09 source
  and confirms the expected repair state. If the enumeration
  finds any one not repaired, Phase E adds an explicit repair
  substep; if the test is right and the source is wrong, the
  escalation protocol engages.
- The exact post-S09 state of
  `tests/utils/runtime-queue-notification.test.ts` and
  `tests/utils/operator-chat-control.test.ts` is determined
  by what S04 and S05 left behind. Phase D.1 / D.2 handle
  either case conditionally.
- The exact set of post-S06 vitest files under
  `web/src/__tests__/components/` corresponding to retired UI
  mutation widgets is determined empirically by Phase A.2.
- The fixture's analyst-capable provider configuration in
  `bootSaivageServer` is the load-bearing operational
  invariant for the analyst-e2e gate. Phase A.1 records the
  pinned analyst model id and whether the run is live or
  playback into `tmp/s10-fixture-analyst-pinning.txt`. If the
  fixture cannot pin a stable analyst-capable provider, the
  analyst-e2e gate becomes nondeterministic and S10 cannot
  reliably pass — the escalation protocol engages and a
  `011-<slug>` follow-up takes ownership of fixture stability.
- The choice of slug for the `011-<slug>` follow-up stage
  (when escalation triggers) is left to the implementer at
  triage time; the slug must describe the substantive failure
  category. MASTER-PLAN-r7 §7 places no constraint beyond
  lowercase-kebab-case and uniqueness against existing NNN
  prefixes.
- The hex-escape rewrite pattern is documented in
  "Approach → Preserving negative-assertion guards" but is
  not itself an existing test-suite convention in saivage-v3.
  Phase E adds a single shared declaration of
  `RETIRED_TOKENS` per affected file rather than a
  workspace-wide constants module, to keep S10's diff surface
  minimal.
