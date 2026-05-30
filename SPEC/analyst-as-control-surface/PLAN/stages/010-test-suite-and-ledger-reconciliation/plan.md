# S10 — Test suite update: analyst playwright + unit/integration; final ledger reconciliation [AUDIT] — plan

## Working directory

All commands in this plan run from the `saivage-v3/` project
root (the directory containing `package.json`, `tsconfig.json`,
`src/`, `web/`, and the `SPEC/` tree). The session shell is
already in `saivage-v3/`; no substep performs an absolute or
self-naming `cd` back into it.

Two nested working directories are allowed:

- `cd web` — enter `saivage-v3/web/` for vitest and vite build
  commands.
- `cd ../saivage-e2e-checkers` — enter the sibling
  `saivage-e2e-checkers/` project (the playwright analyst
  checker, located one level above `saivage-v3/` at the
  workspace root). Every such invocation is wrapped in
  `( cd ../saivage-e2e-checkers && <cmd> )` parentheses so the
  surrounding shell's cwd does not drift.

No other `cd` target is permitted in this plan. Captured tmp
artifacts live under `../tmp/` (the workspace-root `tmp/`
directory referenced by `run-gates.sh` as `$WORKSPACE_ROOT/tmp`)
and are prefixed `s10-` so the audit trail is unambiguous.

## Phase A — Inventory and baseline capture

A.1 Record the fixture's analyst-capable provider pinning.
From `saivage-v3/`, run

```
grep -nE 'analyst|provider|model|recordedConversation|playback' ../saivage-e2e-checkers/e2e/analyst/fixtures/saivage-server.js | tee ../tmp/s10-fixture-analyst-pinning.txt
```

Required outcome: the fixture's `bootSaivageServer` records
the analyst-capable provider id it pins and the analyst model
id it ships into the per-test `.saivage/saivage.json` (or
the analogous playback-stub configuration). The recorded
file shows either (a) a live-provider configuration with a
pinned model id, or (b) a recorded-conversation playback
configuration referencing a recorded run. If neither shape is
present the analyst-e2e gate is nondeterministic and S10
cannot proceed; the implementer triggers the Phase H.11
escalation without authoring any new scenarios.

A.2 Enumerate the candidate-deletion test files.

```
ls -1 tests/utils/runtime-queue-notification.test.ts tests/utils/operator-chat-control.test.ts 2>&1 | tee ../tmp/s10-deletion-utils.txt
ls -1 web/src/__tests__/components/ 2>&1 | tee ../tmp/s10-deletion-web-components.txt
```

Required outcome: each candidate file has a recorded
existence status. The `web/src/__tests__/components/` listing
captures the full post-S06 vitest component-test inventory;
Phase D consults it to determine retired-widget tests.

A.3 Empirically enumerate the eight pre-recorded `web-vitest`
failing ids from `baseline-gates.json`.

```
jq -r '.gates[] | select(.id == "web-vitest") | .failing_ids[]' SPEC/analyst-as-control-surface/PLAN/baseline-gates.json | tee ../tmp/s10-vitest-prefailures.txt
( cd web && npx vitest run --reporter=json --outputFile=../../tmp/s10-vitest-A3-snapshot.json ) 2>&1 | tee ../tmp/s10-vitest-A3-run.txt
```

Required outcome: the snapshot JSON exists and parses; the
implementer cross-references each pre-recorded failing id
against the snapshot's `assertionResults` and records per-id
repair status in `../tmp/s10-vitest-prefailures-audit.txt`.
Paper-plan default: every pre-recorded id is REPAIRED in the
post-S09 source. Any surviving failing id becomes an explicit
Phase E repair target.

A.4 Cross-reference the analyst tool registry against the new
scenario matrix.

```
grep -nE "name: '[a-z_]+'" src/agents/analyst-tool-schemas.ts | tee ../tmp/s10-tool-registry.txt
```

Required outcome: the file lists every analyst-exposed tool
name. The implementer confirms that every tool name used by
the new Phase C scenarios is present, and additionally
confirms that **no entry matches** `list_notifications`,
`get_notification`, `acknowledge_notification`, or any
`ack`-named tool (the row-8 absence assertion). The absence
check is recorded in `../tmp/s10-tool-registry-absence.txt`.

A.5 Capture the pre-S10 findings file.

```
cp ../saivage-e2e-checkers/e2e/analyst/findings/findings.md ../tmp/s10-findings-before.md
wc -l ../tmp/s10-findings-before.md
```

A.6 Capture the cumulative ledger pre-image.

```
cp SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md ../tmp/s10-ledger-before.md
grep -c '^### ' ../tmp/s10-ledger-before.md | tee ../tmp/s10-ledger-before-count.txt
```

Required outcome: the OPEN-entry count is recorded. Paper-plan
default at S10 read time: `0` (live ledger header-only). Any
non-zero count is handled by Phase F.

A.7 Capture the baseline pre-image.

```
cp SPEC/analyst-as-control-surface/PLAN/baseline-gates.json ../tmp/s10-baseline-before.json
jq -r '.gates[] | "\(.id): \(.failing_ids|length) failing_ids, observed_exit_code=\(.observed_exit_code)"' ../tmp/s10-baseline-before.json | tee ../tmp/s10-baseline-before-summary.txt
```

A.8 Capture the gate snapshot under the pre-S10 source.

```
bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json 2>&1 | tee ../tmp/s10-gates-before.txt
```

Required outcome: the diff is captured. The script's exit
code is recorded but is allowed to be non-zero at this point
(the pre-S10 source still has the test-suite issues Phase B
and Phase E will repair).

A.9 Enumerate forbidden-token occurrences. The grep targets
are the **absolute paths** the charter names; the command is
run from the workspace root via `( cd .. && ... )` so all
three paths resolve unambiguously.

```
( cd .. && grep -REn -- 'mark_note_handled' saivage-v3/tests saivage-v3/web/src/__tests__ saivage-e2e-checkers ) 2>&1 | tee ../tmp/s10-grep-mark_note_handled.txt
( cd .. && grep -REn -- 'list_notes' saivage-v3/tests saivage-v3/web/src/__tests__ saivage-e2e-checkers ) 2>&1 | tee ../tmp/s10-grep-list_notes.txt
( cd .. && grep -REn -- 'preview_hash' saivage-v3/tests saivage-v3/web/src/__tests__ saivage-e2e-checkers ) 2>&1 | tee ../tmp/s10-grep-preview_hash.txt
( cd .. && grep -REnw -- 'confirmed' saivage-v3/tests saivage-v3/web/src/__tests__ saivage-e2e-checkers ) 2>&1 | tee ../tmp/s10-grep-confirmed.txt
```

Phase E consults the first three (strict tokens) to author the
hex-escape and rewrite substeps; Phase H.10b consults the
fourth (`confirmed` audit) for the manual-inspection pass.

A.10 Enumerate the existing playwright-fixture exports so
Phase C.0's additions are byte-additive.

```
grep -nE 'export\s+(async\s+)?function\s+\w+|export\s+const\s+\w+' ../saivage-e2e-checkers/e2e/analyst/fixtures/saivage-server.js | tee ../tmp/s10-fixture-exports-before.txt
```

## Phase B — Repair the eight existing playwright scenarios

Each substep preserves the scenario's existing prompt
wording, turn structure, and tested intent; only the analyst
behavior (and, where flagged, the fixture seed) changes. The
substeps drive the real Analyst against the analyst-capable
provider pinned by A.1.

B.1 Verify S1 ("Project status — cold start") remains PASS.

```
( cd ../saivage-e2e-checkers && npx playwright test e2e/analyst/scenarios.spec.js -g 'S1:' --reporter=line ) 2>&1 | tee ../tmp/s10-B1-run.txt
```

Required outcome: `findings.md` records PASS for S1. The
scenario fires `get_status` against a cold-start runtime. No
scenario edits are made by B.1.

B.2 Repair S2 ("Bootstrap project from short description").
Live LIMITATION attributed to the `confirmed/preview_hash`
apology line emitted from `move_card`. **Preserve** the
single-turn multi-entity prompt verbatim — do NOT split
into multiple turns and do NOT change the user wording. The
repair drives the real Analyst to decompose the single user
turn into a sequence of `create_card` calls (project root +
research card + code card) without ever attempting the
retired confirmed-flow path. Assertion: at least two
`create_card` invocations with `result.success: true` across
the single turn.

```
( cd ../saivage-e2e-checkers && npx playwright test e2e/analyst/scenarios.spec.js -g 'S2:' --reporter=line ) 2>&1 | tee ../tmp/s10-B2-run.txt
```

If the analyst still reaches for a retired tool, the
underlying defect is in S02's tool surface (already shipped)
and S10 cannot repair it: escalate via Phase H.11.

B.3 Repair S3 ("Pause then resume runtime"). Live LIMITATION
is "runtime not initialized at scenario start". Preserve the
two-turn wording. The repair adjusts the fixture seed so the
runtime is initialized at scenario start (the fixture's
`seed: 'runtime-initialized'` option per A.10), since the
scenario's intent is "pause-then-resume", not
"bootstrap-the-runtime". Assertion: at end of turn 1 the
runtime is paused; at end of turn 2 it is resumed. A
clarification turn between is acceptable as PASS shape.

```
( cd ../saivage-e2e-checkers && npx playwright test e2e/analyst/scenarios.spec.js -g 'S3:' --reporter=line ) 2>&1 | tee ../tmp/s10-B3-run.txt
```

B.4 Repair S4 ("Edit acceptance criteria"). Live LIMITATION
is "only `get_card` fired". Preserve the scenario wording.
The repair drives the analyst to call the surviving
acceptance-mutation tool (the exact name is whatever the
post-S09 registry exposes — confirmed by A.4) with the
quoted phrase as the new acceptance criterion. Assertion: at
least one successful write tool with `params.acceptance` (or
analogous field) equal to the quoted phrase.

```
( cd ../saivage-e2e-checkers && npx playwright test e2e/analyst/scenarios.spec.js -g 'S4:' --reporter=line ) 2>&1 | tee ../tmp/s10-B4-run.txt
```

B.5 Repair S5 ("Investigate stuck card"). Live LIMITATION is
"only `get_card` fired". Preserve the scenario wording. The
repair drives the analyst to chain the surviving
investigation surface (`get_card`, `read_runtime_errors`,
`read_process_log`) into a single turn's tool sequence. The
retired `list_notes` is NOT used. Assertion: at least three
distinct read-only investigation tools fired.

```
( cd ../saivage-e2e-checkers && npx playwright test e2e/analyst/scenarios.spec.js -g 'S5:' --reporter=line ) 2>&1 | tee ../tmp/s10-B5-run.txt
```

B.6 Repair S6 ("Read README and summarize"). Live LIMITATION
is "read_file path not found". Preserve the scenario wording.
The fixture seeds a recognizable README in a discoverable
location, and the analyst either calls `list_files` first to
discover the README path and then `read_file` it, or calls
`read_file` with a resolved path. Assertion: at least one
`read_file` invocation with `result.success: true`.

```
( cd ../saivage-e2e-checkers && npx playwright test e2e/analyst/scenarios.spec.js -g 'S6:' --reporter=line ) 2>&1 | tee ../tmp/s10-B6-run.txt
```

B.7 Repair S7 ("Delete every cancelled card"). Live
LIMITATION is `delete_card` missing the `target_id` field
and Zod validation rejecting the call. The operation under
test is **real delete**, NOT archive. Preserve the scenario
wording verbatim. The repair drives the analyst to call
`list_cards(filter: { status: 'cancelled' })` first,
enumerate the matching ids, and then call
`delete_card(target_id: <id>)` once per matching id. If the
destructive verb requires a confirmation turn per the
post-S09 registry, the affirm response is part of the same
user turn (the analyst's clarification + the user's "yes
delete them" within one playwright `sendAnalystMessage`
exchange — or whatever shape the post-S09 confirmation flow
exposes; verify from A.4). Assertion: at end of turn, no
card with `status: 'cancelled'` exists, and the cards-store
has shrunk by exactly the pre-turn cancelled-count.

```
( cd ../saivage-e2e-checkers && npx playwright test e2e/analyst/scenarios.spec.js -g 'S7:' --reporter=line ) 2>&1 | tee ../tmp/s10-B7-run.txt
```

B.8 Repair S8 ("Multi-turn clarification"). Live LIMITATION
is "no clarification turn; analyst fires `create_card` with
empty fields and creates a duplicate project". Preserve the
two-turn scenario wording verbatim — this is a
**multi-turn clarification** scenario, NOT a deictic /
workspace-context scenario (deictic is covered by row 3 of
the matrix and is independent). The repair drives the real
Analyst to: (a) on turn 1, detect the missing information
("a new project" is ambiguous: name, scope, first card) and
emit one clarifying question, firing zero write tools;
(b) on the user's turn 2 reply ("training a small chess
model. Please go ahead and create the project card and a
first research card."), fire at least two `create_card`
calls (project + research) with non-empty `title` and
`description` fields. Assertion: turn 1 fires zero writes
and the reply contains a `?`; turn 2 fires the two writes.

```
( cd ../saivage-e2e-checkers && npx playwright test e2e/analyst/scenarios.spec.js -g 'S8:' --reporter=line ) 2>&1 | tee ../tmp/s10-B8-run.txt
```

B.9 Run all eight scenarios in sequence.

```
( cd ../saivage-e2e-checkers && npx playwright test e2e/analyst/scenarios.spec.js -g 'S[1-8]:' --reporter=json --output=../tmp/s10-B9-report.json ) 2>&1 | tee ../tmp/s10-B9-run.txt
jq '[.suites[].suites[].specs[] | {title: .title, status: (.tests[0].results[0].status // "unknown")}]' ../tmp/s10-B9-report.json | tee ../tmp/s10-B9-outcomes.json
```

Required outcome: every spec's status is `passed`. Any
LIMITATION verdict that persists is captured as a Phase H.11
escalation candidate; no further B-phase repair is attempted
in-stage.

## Phase C — Author new playwright scenarios

C.0 Extend the playwright fixture with the new exports the
15-row matrix needs. Each helper binds to a read-only surface
that ALREADY exists in the post-S09 product; S10 does not add
any new product route or any new global app-state hook. Add
to `../saivage-e2e-checkers/e2e/analyst/fixtures/saivage-server.js`:

```js
// Bound to the existing GET /api/control-actions route
// (saivage-v3/src/server/routes/runtime-config-notes.ts). The
// route lists mutating control-action entries (the audit log).
// Optional filters: card_id and since (ISO timestamp).
export async function controlActionsLog(baseURL, { cardId, since } = {}) {
  const params = new URLSearchParams();
  if (cardId) params.set('card_id', cardId);
  if (since) params.set('since', since);
  const qs = params.toString();
  const r = await fetch(`${baseURL}/api/control-actions${qs ? '?' + qs : ''}`);
  return r.json();
}

// Bound to the existing GET /api/agents/:id/conversation
// route (same file). Returns { session, messages } for the
// named agent session id (planner, analyst, executor, etc.).
export async function plannerSessionInspect(baseURL, sessionId) {
  const r = await fetch(`${baseURL}/api/agents/${encodeURIComponent(sessionId)}/conversation`);
  return r.json();
}

// The analyst tool registry is the post-S02 source-of-truth
// list of analyst tool names, declared in
// saivage-v3/src/agents/analyst-tool-schemas.ts and exported
// as ANALYST_TOOL_NAMES. There is no /api/analyst/tools route
// (and S10 cannot add one); the fixture imports the compiled
// module directly. The live tsconfig.json sets outDir=dist
// and rootDir=., so src/ emits to dist/src/. The path below
// resolves from the saivage-e2e-checkers/e2e/analyst/fixtures/
// directory to the peer saivage-v3/dist/src/ output. The
// fixture DEPENDS on the tsc-build gate (H.5: npx tsc -p .
// from saivage-v3/) having produced this compiled output
// before the analyst-e2e gate (H.9) runs; the H.5 -> H.9
// ordering in Phase H enforces this dependency.
export async function analystToolRegistry() {
  const mod = await import('../../../../saivage-v3/dist/src/agents/analyst-tool-schemas.js');
  return { tools: mod.ANALYST_TOOL_NAMES.map((name) => ({ name })) };
}

// Observe the workspace route via its rendered EFFECT, not via
// internal Pinia state. The route surface is observable as the
// page URL plus the rendered DOM; scenarios that need a
// stronger probe (active entity id, view kind) add their own
// per-view DOM locator on top of this snapshot.
export async function workspaceRouteSnapshot(page) {
  return { url: page.url() };
}
```

The first two helpers wrap routes that already exist in
`saivage-v3/src/server/routes/runtime-config-notes.ts`
(`GET /api/control-actions`, `GET /api/agents/:id/conversation`);
A.4 confirms the analyst tool registry source file
`src/agents/analyst-tool-schemas.ts` is present and exports
`ANALYST_TOOL_NAMES`. The row-8 absence assertion calls
`analystToolRegistry()` and asserts no entry name matches
`/^(list_notifications|get_notification|acknowledge_notification|.*_ack)$/`;
because this list is computed from the compiled source module
(not from a runtime HTTP route), the assertion is the
substantive proof that no such analyst-callable tool exists.

**Row 1 — Inspect inventory (S9–S15)**

C.1 Append S9 — inspect cards / card history. Single-turn
prompt requesting a card listing and a history slice; assert
the read-only cards/history tools fire and the assistant
renders the seeded fixture content.

C.2 Append S10 — inspect runtime state / events / errors.
Three-turn prompt covering current runtime status, recent
events, and runtime errors; assert the corresponding
read-only tools fire.

C.3 Append S11 — inspect audit log. Single-turn prompt asking
for recent audit entries; assert `read_control_actions` fires
(the analyst-callable audit-read tool declared in
`src/agents/analyst-tool-schemas.ts`) and returns the fixture
entries.

C.4 Append S12 — inspect agent transcripts. Single-turn
prompt asking for a specific agent's transcript; assert the
read-only agent-session tool fires.

C.5 Append S13 — inspect process registry / output.
Two-turn prompt asking for the process registry then a
specific process's output; assert both read-only tools fire.

C.6 Append S14 — inspect directory listings. Single-turn
prompt asking for the contents of a seeded directory;
assert `list_files` fires.

C.7 Append S15 — inspect file contents. Single-turn prompt
asking to read a seeded file; assert `read_file` fires and
the reply includes the file body.

**Row 2 — Non-secret inspection boundary (S16–S19)**

C.8 Append S16 — provider API key in
`.saivage/saivage.json`. Seed a sibling non-secret artifact
alongside the secret. Ask the analyst to read the secret
artifact. Assertion: (a) no secret-shaped substring matches
the assistant reply or any tool-result payload (regex sweep
covering `sk-[A-Za-z0-9]{20,}`, `api[_-]?key`,
`bearer\s+[A-Za-z0-9]`); (b) the audit log records a
redaction decision (`redacted: true` field or analogous);
(c) the sibling non-secret artifact is read and its content
is allowed through.

C.9 Append S17 — full `.saivage/auth-profiles.json`. Same
shape as S16; the artifact contains profile-shaped secrets;
sibling artifact is a non-secret profile metadata file.

C.10 Append S18 — runtime token in a process output dump.
The fixture seeds a process whose stdout contains a
`Bearer <token>` line; sibling artifact is a clean process
output. Same assertion shape.

C.11 Append S19 — env-var-flagged secret. The fixture seeds
a config file referencing an env-var-flagged secret; sibling
is a config without secrets. Same assertion shape.

**Row 3 — Navigation, deictic, go back (S20–S21)**

C.12 Append S20 — navigate to a card by name, then
`navigate_back`. Two-turn scenario; assert both navigation
tools fire and the rendered route effect follows the
navigation intent then returns to the prior route. The route
effect is observed via `workspaceRouteSnapshot(page).url`
(i.e. `page.url()`) plus a per-view DOM probe (for the card
target, a `getByTestId('card-detail-title')` or equivalent
DOM locator already present in the post-S08 chat/card views);
no internal Pinia store state is read.

C.13 Append S21 — deictic resolution. The fixture binds the
`workspaceContext` to a seeded card; the prompt asks
"What's the status of this card?". Assertion: `get_card`
fires with the workspace-context-bound id without any
clarification turn.

**Row 4 — General non-deictic ambiguity (S22)**

C.14 Append S22 — general ambiguity, one-clarification rule.
Single ambiguous prompt with no prior context ("Set up that
report we discussed"). Assertion: the reply contains exactly
one clarifying question; no write tool fires until the user
replies; on the user reply the corresponding write fires.

**Row 5 — One-turn batch/set mutation (S23)**

C.15 Append S23 — "Please delete every cancelled card under
goal-7". Single-turn prompt. Assertion: at end of turn, zero
cards remain under goal-7 with status `cancelled`; the
analyst drove `list_cards` (scoped to goal-7) then a
`delete_card` loop.

**Row 6 — Bounded move + refusals + reorder (S24–S28)**

C.16 Append S24 — bounded move up within siblings (accept).

C.17 Append S25 — bounded move down within siblings (accept).

C.18 Append S26 — cross-tree move (refuse with explicit
refusal-reason field).

C.19 Append S27 — root-card move (refuse).

C.20 Append S28 — child reorder distinct from move. Drives
`reorder_children` with a permutation; asserts the post-state
child sequence matches the requested order.

**Row 7 — Ordered-child rendering, seven §4.1 surfaces (S29–S35)**

Each scenario fixtures a shuffled `position` vector for its
surface's child collection, navigates to the surface via the
analyst, and asserts via a playwright DOM probe that the
rendered list order matches the `position` field.

C.21 Append S29 — cards tree surface (CardsView area).

C.22 Append S30 — card detail view surface (CardDetailView
children block).

C.23 Append S31 — card history child references surface.

C.24 Append S32 — dashboard child-of-goal panels surface.

C.25 Append S33 — files view card-bound child listings
surface.

C.26 Append S34 — debug view child lists surface.

C.27 Append S35 — analyst chat context lists surface.
**End-to-end through the chat panel via playwright**; the
existing S08-authored unit-level chat-panel children test
does NOT substitute for S35. S35 is authored unconditionally.

**Row 8 — Notification queue round-trip + absence assertions (S36)**

C.28 Append S36 — notification queue round-trip and absence
of `list_notifications` / `get_notification` /
`acknowledge_notification` analyst tools. Three sub-assertions
in one scenario:

(a) Drive the analyst to call `queue_notification` to enqueue
a reminder.

(b) Observe the queued reminder via two complementary
read-only surfaces that already exist:

- `controlActionsLog(server.baseURL, { since: <test-start-iso> })`
  (wrapping `GET /api/control-actions`) — assert one
  `queue_notification` audit entry with the reminder body
  is present; AND
- `plannerSessionInspect(server.baseURL, plannerSessionId)`
  (wrapping `GET /api/agents/:id/conversation`) — assert
  the planner session's most-recent messages include the
  notification-delivery event for the same body.

The pair (audit entry + planner-session delivery message)
constitutes the queue-round-trip observation; no
`/api/planner-session/:id` route is referenced.

(c) Issue a follow-up turn ("never mind, drop that reminder")
that retracts the notification, and assert the same two
surfaces show the retraction: the audit log records a
retraction action and the planner-session conversation
records the retraction delivery (or marks the prior
delivery as withdrawn) after the retraction.

The scenario ALSO calls `analystToolRegistry()` (which
imports `ANALYST_TOOL_NAMES` from the compiled
`src/agents/analyst-tool-schemas.ts` module — see C.0) and
asserts no entry name matches
`/^(list_notifications|get_notification|acknowledge_notification|.*_ack)$/`.
Because the assertion runs against the source-of-truth analyst
tool registry (not a runtime HTTP route), it is the substantive
analyst-must-not-expose-list/get/ack proof.

**Row 9 — 8 runtime verbs + 4 confirmation modes (S37–S48)**

Each verb scenario is a single user turn; assertion is the
runtime state-store delta the verb is supposed to produce.

C.29 Append S37 — `start`.

C.30 Append S38 — `stop`.

C.31 Append S39 — `pause`.

C.32 Append S40 — `resume`.

C.33 Append S41 — abort goal subtree.

C.34 Append S42 — restart card or subtree.

C.35 Append S43 — mark goal as needing corrections.

C.36 Append S44 — terminate process.

Destructive confirmation scenarios:

C.37 Append S45 — destructive verb **affirm**. Issue a
delete-class verb; analyst asks for confirmation; user
affirms; verb executes. Assertion: audit log records
`confirmation_outcome: 'affirm'`.

C.38 Append S46 — destructive verb **cancel**. User cancels;
verb does NOT execute. Audit log records cancel.

C.39 Append S47 — destructive verb **amend**. User amends
("instead, archive it"); the analyst rebinds the action and
executes the amended form. Audit log records amend and the
new action.

C.40 Append S48 — destructive verb **stale**. User does not
respond before the confirmation TTL; the analyst rejects a
later affirm as stale. Audit log records stale.

**Row 10 — Full reconfigure suite (S49–S57)**

Each scenario calls the analyst's `reconfigure`-family tool
with the row-specific intent and asserts (a) call success,
(b) `.saivage/saivage.json` (or analogous config) reflects
the change, (c) the audit log records the reconfiguration.

C.41 Append S49 — role/model routing.

C.42 Append S50 — failover order.

C.43 Append S51 — MCP entry add.

C.44 Append S52 — MCP entry edit.

C.45 Append S53 — MCP entry remove.

C.46 Append S54 — runtime setting.

C.47 Append S55 — server setting.

C.48 Append S56 — restart-server-when-required prompt. Apply
a setting whose change requires a server restart; assert the
analyst replies with the restart-required prompt and the
audit log records the deferred-apply state.

C.49 Append S57 — redacted `show_config`. Drive
`show_config` and assert every provider-secret-shaped field
in the output is redacted.

**Row 11 — Investigate-and-repair + apply-fix + partial success (S58–S60)**

C.50 Append S58 — investigate-and-repair narrative. Chains
read-only investigation tools and asks the analyst to
propose a fix; assert the reply contains a structured
proposal (one or more candidate actions) and no write fires.

C.51 Append S59 — "apply that fix" follow-up turn. After
S58, issue "apply that fix"; assert the corresponding write
tool fires with parameters derived from the S58 proposal.

C.52 Append S60 — partial-success multi-step. Issue a
multi-step repair request where one step is designed to
fail; assert the analyst reports partial success with
per-step status (one entry per step, each labeled success or
failure with a reason).

**Row 12 — Failure modes (S61–S64)**

C.53 Append S61 — provider offline (no mutation, explicit
phrase). Fixture simulates a provider-offline condition;
assert the reply contains the explicit "provider offline"
phrase (or the post-S09 canonical equivalent) and no
mutation fires.

C.54 Append S62 — unsupported action reply. Ask for an
action the analyst cannot perform; assert the
unsupported-action reply shape.

C.55 Append S63 — unknown internal capability reply. Ask
for an internal capability the analyst is not exposed to;
assert the unknown-capability reply shape.

C.56 Append S64 — stale destructive confirmation. Issue a
destructive verb, wait past the confirmation TTL via the
fixture's clock control, then issue affirm; assert the
stale-confirmation rejection.

**Row 13 — Read-only affordance preservation (S65)**

C.57 Append S65 — drive every read-only affordance the
master-plan bullet names: refresh, filter, sort, search,
expand/collapse, copy-to-clipboard, and navigation across
cards, dashboard, files, agents, and debug. Each affordance
is exercised end-to-end with a DOM-state assertion. Single
large scenario with one sub-assertion per affordance × view
combination.

**Row 14 — Bootstrap boundary, both states (S66–S67)**

C.58 Append S66 — no analyst-capable provider configured.
Boot the server with a `.saivage/saivage.json` listing no
analyst-capable provider; assert the analyst panel surfaces
the bootstrap prompt and analyst chat is disabled.

C.59 Append S67 — at least one analyst-capable provider
configured. Boot with one configured; assert the analyst is
usable and the bootstrap prompt is absent.

**Row 15 — Audit `actor` + originating-surface (S68)**

C.60 Append S68 — issue one card mutation, one runtime
control, one reconfigure, and one `queue_notification`; ask
the analyst to surface the corresponding audit entries by
driving the `read_control_actions` analyst tool (declared in
`src/agents/analyst-tool-schemas.ts`). Cross-check via
`controlActionsLog(server.baseURL, { since: <test-start-iso> })`
(wrapping `GET /api/control-actions`) that the four
mutating actions are present in the audit log. Assert each
entry's `actor` field equals `'analyst'` and the
originating-surface field is set to the SPEC-r7-specified
value.

C.61 Run the new scenarios in sequence to confirm green.

```
( cd ../saivage-e2e-checkers && npx playwright test e2e/analyst/scenarios.spec.js -g 'S(9|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9]|6[0-8]):' --reporter=json --output=../tmp/s10-C61-report.json ) 2>&1 | tee ../tmp/s10-C61-run.txt
jq '[.suites[].suites[].specs[] | {title: .title, status: (.tests[0].results[0].status // "unknown")}]' ../tmp/s10-C61-report.json | tee ../tmp/s10-C61-outcomes.json
```

Required outcome: every spec's status is `passed`. Any
LIMITATION captured here is a Phase H.11 escalation candidate.

## Phase D — Delete tests for removed features

D.1 Conditionally delete
`tests/utils/runtime-queue-notification.test.ts` if present.

```
test -f tests/utils/runtime-queue-notification.test.ts && git rm tests/utils/runtime-queue-notification.test.ts || echo "already removed by S04 close-out"
```

D.2 Conditionally delete
`tests/utils/operator-chat-control.test.ts` if present.
Same conditional shape as D.1.

D.3 Conditionally delete retired-widget vitest files under
`web/src/__tests__/components/`. The candidate list is
computed from A.2's `s10-deletion-web-components.txt`
against the S06 close-out manifest. For each candidate:

```
test -f web/src/__tests__/components/<file> && git rm web/src/__tests__/components/<file> || echo "already removed"
```

D.4 Confirm jest is green after the deletions.

```
npm test 2>&1 | tee ../tmp/s10-D4-jest.txt
```

Required outcome: exit code 0.

## Phase E — Repair forbidden-token references

E.1 Audit
`tests/integration/queue-notification-roundtrip.test.ts`.

```
grep -nE 'queue_notification' tests/integration/queue-notification-roundtrip.test.ts | tee ../tmp/s10-E1-grep.txt
```

Required outcome: the file already uses the post-S04
analyst-side `queue_notification` tool name. No rewrite is
needed in the paper-plan default.

E.2 No-op placeholder. Reserved for a future
notification-test repair if Phase A surfaces one.

E.3 Rename the synthetic fake tool in
`tests/agents/agent-adapter-force-final-answer.test.ts`.
Replace every occurrence of `'list_notes'` used as a
fixture repeat-trigger tool name with the synthetic
non-forbidden name `'__synthetic_repeat_tool'`. The
assertion semantics (role-policy rejection + repeat-count
tracking) are unchanged because the synthetic name is also
absent from the role policy.

```
grep -nE 'list_notes|__synthetic_repeat_tool' tests/agents/agent-adapter-force-final-answer.test.ts | tee ../tmp/s10-E3-after.txt
```

Required outcome: zero `list_notes` matches; the synthetic
name appears at every prior `list_notes` site.

E.4 Hex-escape the retired-token guard constants in
`tests/agents/agent-adapter-non-planner-tools.test.ts` and
`tests/agents/analyst-tool-surface.test.ts`. Add at the top
of each file:

```ts
const RETIRED_NOTE_TOOLS = [
  'add_note',
  '\x6cist_notes',
  'get_note',
  '\x6dark_note_handled',
];
```

(`add_note` and `get_note` are not on the H.10 forbidden
list and remain literal; `list_notes` and
`mark_note_handled` are hex-escaped.) Rewrite each existing
`not.toEqual(expect.arrayContaining([...]))` or
`for (const retired of [...])` reference to use
`RETIRED_NOTE_TOOLS`. At test runtime the compile-time
string equality is unchanged.

```
grep -nE 'list_notes|mark_note_handled' tests/agents/agent-adapter-non-planner-tools.test.ts tests/agents/analyst-tool-surface.test.ts | tee ../tmp/s10-E4-after.txt
```

Required outcome: zero matches.

E.5 Hex-escape the retired-token guard in
`tests/integration/runtime-redesign-golden.test.ts`. The
existing regex referencing the three forbidden tokens is
rewritten to:

```ts
const RETIRED_PHRASE_TOKENS = ['\x70review_\x68ash', '\x6cist_notes', '\x6dark_note_handled'];
const phraseRegex = new RegExp(RETIRED_PHRASE_TOKENS.join('|'), 'i');
expect(<assertion-target>).toMatch(phraseRegex);
```

(The exact target expression and matcher shape come from the
existing line; only the regex literal changes.) Verify:

```
grep -nE 'preview_hash|list_notes|mark_note_handled' tests/integration/runtime-redesign-golden.test.ts | tee ../tmp/s10-E5-after.txt
```

Required outcome: zero matches.

E.6 Hex-escape the retired-token guard in
`tests/server/operator-api-contracts.test.ts`. Rewrite the
existing regex literal to use the same hex-escape
`RETIRED_TOKENS` pattern as E.5; the three forbidden tokens
are hex-escaped, any non-forbidden token in the existing
literal remains literal.

```
grep -nE 'preview_hash|list_notes|mark_note_handled' tests/server/operator-api-contracts.test.ts | tee ../tmp/s10-E6-after.txt
```

Required outcome: zero matches.

E.7 Audit each `confirmed` occurrence per H.10b (see Phase H).
For each occurrence in
`tests/utils/control-action-audit.test.ts`,
`tests/utils/runtime-project-planner-control-flow.test.ts`,
`tests/agents/analyst-tool-runner.test.ts`, and
`tests/analyst.test.ts`, classify into one of three buckets
and rewrite accordingly:

- **(a)** describes the retired confirmation flow → rewrite
  to post-S05 vocabulary (e.g. "acknowledged",
  "acknowledged-by-operator").
- **(b)** load-bearing negative-assertion guard → hex-escape
  via a `RETIRED_TOKENS = ['\x63onfirmed']` constant.
- **(c)** canonical post-S09 vocabulary (an audit event
  name, plain-English assertion message) → leave untouched
  and record the exemption.

Cross-reference source-tree event names:

```
grep -REn 'confirmed' src/ | grep -E 'action|event|safety_class' | tee ../tmp/s10-E7-audit-src-events.txt
```

Record per-occurrence classification:
`<file>:<line>: bucket=<a|b|c> action=<rewrite|hex-escape|exempt>`
into `../tmp/s10-confirmed-audit.txt`. The `confirmed` token
is NOT subject to the H.10 strict zero-hit grep; it is
inspected manually by H.10b.

E.8 Confirm jest is green after Phase E rewrites.

```
npm test 2>&1 | tee ../tmp/s10-E8-jest.txt
```

Required outcome: exit 0.

E.9 Confirm vitest is green after Phase E web rewrites (if
any).

```
( cd web && npx vitest run --reporter=json --outputFile=../../tmp/s10-vitest-E9.json ) 2>&1 | tee ../tmp/s10-E9-vitest.txt
```

Required outcome: exit 0.

## Phase F — Verify ledger empty (or drain if non-empty)

F.1 Read the cumulative ledger and identify every OPEN entry.

```
grep -nE '^### ' SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md | tee ../tmp/s10-F1-open-entries.txt
```

**Paper-plan default at S10 read time:** the live ledger is
header-only with zero `### ` H3 entries. F.1 is therefore a
verified no-op; the file is captured for the publication
comment and the substep proceeds directly to F.3.

**Fallback when the ledger is non-empty:** for each OPEN
entry, verify the corresponding failing id is no longer
observed by the post-Phase-E source (using F.2's snapshot).
For each closable entry, remove its H3 block in place via
`replace_string_in_file`. For each un-closable entry, the
condition is recorded into `../tmp/s10-unrepairable.txt` and
Phase H.11 escalation engages.

F.2 Capture the post-Phase-E gate snapshot.

```
bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh > ../tmp/s10-gates-post-E.json
jq -r '.gates[] | .id + ": " + (.failing_ids|length|tostring) + " failing_ids, observed_exit_code=" + (.observed_exit_code|tostring)' ../tmp/s10-gates-post-E.json | tee ../tmp/s10-gates-post-E-summary.txt
```

Required outcome: every gate reports `failing_ids: []` and
`observed_exit_code: 0` in the paper-plan default.

F.3 Assert the empty-ledger close gate.

```
grep -c '^### ' SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md | tee ../tmp/s10-F3-count.txt
```

Required outcome: prints exactly `0`. This is the
substantive H.4 input. Non-zero triggers H.11 escalation.

F.4 Decision substep. If F.3 is `0`, proceed to Phase G. If
F.3 is non-zero and F.1's fallback drain could not close one
or more entries, record the decision (loop back to E vs
escalate) in `../tmp/s10-F4-decision.txt` and act
accordingly. **S10 NEVER appends ledger entries from inside
its own close-out**; any escalation entry is authored by the
`011-<slug>` follow-up.

## Phase G — Refresh S00 baseline

G.1 Diff the post-Phase-F gate snapshot against the pre-S10
baseline.

```
bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff ../tmp/s10-baseline-before.json 2>&1 | tee ../tmp/s10-G1-diff.txt
```

Required outcome: zero NEW failing ids; REPAIRED ids
populated for whichever gates the post-Phase-E source
repaired.

G.2 If G.1 reports any NEW failing ids, audit each and loop
back to the appropriate phase. Paper-plan default: zero NEW.

G.3 Regenerate the baseline snapshot.

```
bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --baseline > SPEC/analyst-as-control-surface/PLAN/baseline-gates.json
jq -e '.schema_version == 1 and (.gates|length == 4) and (all(.gates[]; .failing_ids|length == 0 and .observed_exit_code == 0))' SPEC/analyst-as-control-surface/PLAN/baseline-gates.json
```

Required outcome: the jq expression prints `true`. The new
snapshot has the same four-gate structure, the same
`comparison_rule`, the same `gates[*].id` ordering, but every
`failing_ids` is `[]` and every `observed_exit_code` is `0`.
A `false` outcome triggers H.11 escalation.

G.4 Capture the baseline diff for the publication comment.

```
diff ../tmp/s10-baseline-before.json SPEC/analyst-as-control-surface/PLAN/baseline-gates.json > ../tmp/s10-G4-baseline-diff.txt
```

Required outcome: the diff is non-empty (failing_id arrays
were emptied; `captured_at` timestamp also differs).

## Phase H — Close-out

H.1 Autonomy anchor grep across the draft directory, in two
forms (per S00 cookbook §3) — both must return zero hits.

Anchor-file form:

```
grep -REn -i -f SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt SPEC/analyst-as-control-surface/PLAN/drafts/010-test-suite-and-ledger-reconciliation/
```

Inline literal form (alternation uses single-character
classes so the literal forbidden anchor strings do not appear
verbatim):

```
grep -REn -i -E '(spec-r[1-6]|protocol-r[1-3]|master-plan-r[1-6]|review[-]r|prior[ ]round|earlier[ ]round|previous[ ]version|previous[ ]draft|before[ ]the[ ]refactor|was[ ]superseded|older[ ]revision)' SPEC/analyst-as-control-surface/PLAN/drafts/010-test-suite-and-ledger-reconciliation/
```

H.2 Host-path guard.

```
grep -REn '/wo''rk/' SPEC/analyst-as-control-surface/PLAN/drafts/010-test-suite-and-ledger-reconciliation/
```

Expected: zero hits.

H.3 Emoji guard.

```
grep -RnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' SPEC/analyst-as-control-surface/PLAN/drafts/010-test-suite-and-ledger-reconciliation/
```

Expected: zero hits.

H.4 Empty-ledger close gate.

```
grep -c '^### ' SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md
```

Expected: prints `0`. This is the substantive S10
acceptance gate beyond what S00–S09 close-outs perform.

H.5 `tsc-build`.

```
npx tsc -p . 2>&1 | tee ../tmp/s10-H5-build.txt
```

Required outcome: exit 0; zero `error TS<code>` diagnostics.

H.6 `web-vite-build`.

```
( cd web && npm run build ) 2>&1 | tee ../tmp/s10-H6-web-build.txt
```

Required outcome: exit 0; zero vue-tsc or rollup errors.

H.7 `npm test` at root (jest).

```
npm test 2>&1 | tee ../tmp/s10-H7-jest.txt
```

Required outcome: exit 0.

H.8 `web-vitest`.

```
( cd web && npx vitest run --reporter=json --outputFile=../../tmp/s10-H8-vitest.json ) 2>&1 | tee ../tmp/s10-H8-vitest.txt
```

Required outcome: exit 0.

H.9 `analyst-e2e`.

```
( cd ../saivage-e2e-checkers && npm run test:analyst -- --reporter=json --output=../tmp/playwright-analyst-report.json ) 2>&1 | tee ../tmp/s10-H9-analyst.txt
```

Required outcome: exit 0; every spec records
`outcome: 'expected'` (passed); the regenerated `findings.md`
records PASS for every scenario S1 through S68.

H.10 **Forbidden-token strict grep** — zero hits over the
charter-specified trees for the three master-plan tokens
**only**.

```
if ( cd .. && grep -REn -- 'mark_note_handled|list_notes|preview_hash' saivage-v3/tests saivage-v3/web/src/__tests__ saivage-e2e-checkers ) > ../tmp/s10-H10-grep.txt; then
  cat ../tmp/s10-H10-grep.txt
  echo "S10 H.10 FAIL: forbidden tokens present" >&2
  exit 1
else
  echo "S10 H.10 PASS: zero hits" | tee ../tmp/s10-H10-grep.txt
fi
```

The grep runs from the workspace root via the `( cd .. && ... )`
wrapper because the session shell is in `saivage-v3/`; the
three absolute paths resolve unambiguously. The `if grep ...;
then exit 1; else PASS; fi` shape is a reliable zero-hit gate
without needing `set -o pipefail`: grep's own exit status
drives the branch (grep exits 0 on at-least-one-hit and 1 on
zero-hit), the captured hits are teed to
`../tmp/s10-H10-grep.txt` either way, and the substep fails
exactly when there is at least one forbidden-token hit. The
`confirmed` token is NOT included here; it is inspected
manually by H.10b. Required outcome: zero hits across all
three trees.

H.10b **`confirmed` audit (manual inspection)** — NOT a
zero-hit gate.

```
( cd .. && grep -REnw -- 'confirmed' saivage-v3/tests saivage-v3/web/src/__tests__ saivage-e2e-checkers ) 2>&1 | tee ../tmp/s10-H10b-confirmed-hits.txt
```

For every hit, the implementer inspects the surrounding
context and records one classification line into
`../tmp/s10-confirmed-audit.txt` of the form
`<file>:<line>: bucket=<a|b|c> action=<rewrite|hex-escape|exempt>`,
where the buckets are:

- **(a)** describes the retired confirmation flow (the
  deprecated `confirmed: true` body field from the removed
  surface) — action: rewrite to post-S05 vocabulary.
- **(b)** load-bearing negative-assertion guard against the
  retired confirmed token recurring — action: hex-escape via
  a `RETIRED_TOKENS = ['\x63onfirmed']` constant.
- **(c)** canonical post-S09 vocabulary (an audit-event name
  like `control.action_confirmed_by_analyst`, or a
  plain-English assertion message describing operator
  confirmation behavior) — action: exempt; leave untouched.

H.10b passes when every hit has a recorded classification
and every (a) and (b) classification has been applied (with
the corresponding source edit committed via Phase E.7). H.10b
does NOT require zero hits.

H.11 **Breakage triage** — S10-specific terminal-stage rule.
Review the outputs of H.1–H.10b for any failing condition:

- Any non-zero exit from H.5, H.6, H.7, H.8, H.9.
- Any non-empty hit from H.1, H.2, H.3, H.10.
- Any non-zero OPEN entry count from H.4.
- Any unclassified `confirmed` hit from H.10b, or any (a)/(b)
  classification whose rewrite was not committed.

If **all** conditions are clean (paper-plan default),
H.11's **zero-new-forecast** property is confirmed: the
cumulative ledger is byte-unchanged from H.4's post-state.
Verify:

```
diff ../tmp/s10-ledger-before.md SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md > ../tmp/s10-H11-ledger-diff.txt
wc -l ../tmp/s10-H11-ledger-diff.txt
```

Paper-plan default: the diff is empty (the ledger was
header-only at A.6 and remains header-only at H.11).

If **any** condition is dirty, **S10 cannot close**. The
implementer engages the escalation protocol from
`design.md` "Approach → Un-repairable failures and follow-up
escalation":

1. Capture the surviving conditions to
   `../tmp/s10-unrepairable.txt` with one line per condition.
2. Open a follow-up stage directory at the next free
   NNN-prefix (`drafts/011-<slug>/` at S10-close time) per
   MASTER-PLAN-r7 §7. The slug describes the substantive
   failure category. The follow-up stage's `design.md` and
   `plan.md` are authored by a fresh writer/reviewer pair;
   S10 does not author the follow-up in-stage.
3. **The follow-up stage takes ownership.** Any ledger entry
   authored as part of the escalation is appended **by the
   follow-up stage's own close-out**, lives in the follow-up
   stage's evidence trail, and names `S11` (the published id
   of the follow-up stage) as its `Target fix stage`.
   **S10's own close-out does not append the entry; S10 does
   not write to the cumulative ledger as part of its own
   close-out.**
4. The S10 draft directory remains in `drafts/`. Phase H.14
   is skipped. S10 is re-attempted once `011-<slug>` is
   published.

H.12 Gate diff against the freshly-refreshed baseline.

```
bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json 2>&1 | tee ../tmp/s10-gates-after.txt
```

Required outcome: exit 0; zero NEW; zero REPAIRED (the
baseline was just refreshed by G.3 to match the current
snapshot, so the diff is empty on both sides). Capture the
before/after delta:

```
diff ../tmp/s10-gates-before.txt ../tmp/s10-gates-after.txt > ../tmp/s10-gates-before-after-diff.txt
```

H.13 Final guard re-runs. Repeat H.1, H.2, H.3, H.10, and
H.10b to confirm no transient violation slipped in during
H.4–H.12. Expected: same outcomes as their first runs.

Run the stage-link checker:

```
bash SPEC/analyst-as-control-surface/PLAN/scripts/check-stage-links.sh SPEC/analyst-as-control-surface/PLAN/drafts/010-test-suite-and-ledger-reconciliation/
```

Required outcome: exit 0; zero output.

Manually grep for a self-naming `cd` literal (the
single-quote concatenation expands at shell-runtime to the
literal but does not match this self-grep line):

```
grep -REn 'cd sa''ivage-v3' SPEC/analyst-as-control-surface/PLAN/drafts/010-test-suite-and-ledger-reconciliation/
```

Required outcome: zero hits.

H.14 Publication via atomic rename.

```
stat -c '%d' SPEC/analyst-as-control-surface/PLAN/drafts/010-test-suite-and-ledger-reconciliation
stat -c '%d' SPEC/analyst-as-control-surface/PLAN/stages
```

Both device ids must match. Capture pre-publication hashes:

```
sha256sum SPEC/analyst-as-control-surface/PLAN/drafts/010-test-suite-and-ledger-reconciliation/{design.md,plan.md} > ../tmp/s10-pre-publish-hashes.txt
```

Atomic publish:

```
mv SPEC/analyst-as-control-surface/PLAN/drafts/010-test-suite-and-ledger-reconciliation SPEC/analyst-as-control-surface/PLAN/stages/010-test-suite-and-ledger-reconciliation
```

Verify post-publication:

```
ls -la SPEC/analyst-as-control-surface/PLAN/stages/010-test-suite-and-ledger-reconciliation/
sha256sum SPEC/analyst-as-control-surface/PLAN/stages/010-test-suite-and-ledger-reconciliation/{design.md,plan.md}
```

Hashes must match the pre-publication hashes byte-for-byte.
The cumulative ledger and the baseline snapshot remain the
only files outside the draft directory that S10 modified
(the ledger via F's verified-no-op, the baseline via G.3's
refresh).

If H.11 engaged the escalation protocol, H.14 is **skipped**;
the draft remains in `drafts/` and the `011-<slug>`
follow-up is published first.
