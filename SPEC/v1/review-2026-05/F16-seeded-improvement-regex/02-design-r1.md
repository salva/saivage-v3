# F16 — Design (round 1)

## Goal

Re-author T35 and T38 in the Phase-2 audit test matrix so the pass criterion measures *that the planner started work on the seeded gap*, not *which literal words it chose*. Make the criterion robust against any valid improvement the planner picks.

## Chosen design — replace literal-token regex with structural linkage

Replace the `/capture|announce/i` substring match with a structural check: **the planner must create at least one child card whose root-card ancestry points at the seeded project root, whose `type` is `code` or `analysis`, and whose status entered a non-`backlog` state within the polling window**. Optionally (advisory only, not pass-gating), record the chosen title so reviewers can confirm semantic alignment with `docs/SPEC.md` by inspection.

### New T35 pass criteria

```
- card count grew (at least one new child of the project root since T34 baseline)
- the new card is non-trivial: type ∈ {code, analysis}, has a non-empty acceptance
  list, and reached status ∈ {planned, ready, running, blocked, done} (i.e. not
  parked in 'backlog')
- the new card's parent_id (or hierarchical ancestor) is the seeded project root
- (advisory) record card.title and card.acceptance verbatim into the artifact
  json:t35-cards.json for human review against docs/SPEC.md
```

### New T38 wording

- Title: `"Outcome: long-run — wait for the planner-selected seeded improvement to reach a terminal status"`.
- Purpose: `"Allow Saivage up to 5 min after T35 to take the planner-selected seeded-improvement card (whatever its title) to a terminal status (ideally 'done')."`
- Plan step 1 changes from `"Identify capture-announcement child card id C"` to `"Identify the child card id C produced by T35 (carried forward as a matrix variable; see T35 pass-criteria record)"`.
- Pass criteria unchanged (terminal status within 300 s; if `done`, proceed to T39–T44).

### Authoring rule (new)

Add a single guideline to the matrix-authoring prompt — pass criteria for LLM-output dimensions must never literal-match planner-chosen tokens. Use structural / hierarchical / status-machine properties instead. This stops the regression from being re-introduced when a future audit phase is authored.

## Why structural linkage and not other approaches

- It is **deterministic** — `parent_id`, `type`, `status`, `acceptance.length` are properties of the card-store schema (`src/cards/card-store.ts`), not of LLM output text.
- It is **planner-output-invariant** — any valid improvement the planner chooses will satisfy the criterion identically.
- It still **measures the intended invariant** — "the planner took the seeded backlog and produced concrete work", which is what T35 actually wants to assert.
- It produces a **machine-readable artefact** (`json:t35-cards.json` already required) that downstream tests (T38/T39/T44) consume by id, not by title — so the chain stays robust.

## Alternatives considered (and rejected)

### Alt A — Broaden the regex

Reasoning: "expand `/capture|announce/i` to cover the known valid improvements (`/capture|announce|jump|multi[- ]jump|draw|pdn/i`)".

Rejected because:
- Still literal-token-based; planner can pick any *other* valid improvement (e.g. "highlight legal destinations", "undo last move", "score history") and the regex breaks again.
- Couples the test matrix to the contents of `docs/SPEC.md`; a spec edit would silently break the matrix.
- Adds maintenance burden without removing the underlying class of failure.

### Alt B — Pin planner to deterministic output

Reasoning: "set planner temperature to 0 and / or force-seed the prompt with the exact title".

Rejected because:
- Constrains the system under test in a way that hides real planner behaviour.
- Phase-2 explicitly measures provider-wired end-to-end behaviour — pinning the planner defeats that.
- Workspace policy ("architecture-first, no backward compatibility") favours fixing the test, not bending the product to the test.

### Alt C — Convert T35 to a manual / advisory check

Reasoning: "remove the automated pass criterion; have the auditor judge semantic alignment with `docs/SPEC.md` by hand".

Rejected because:
- Loses the per-test automated gate; reintroduces audit-load on every Phase-N run.
- Structural linkage (Alt = chosen design) is just as deterministic without surrendering automation.

### Alt D — Add a `seededImprovementHint` field to the planner contract

Reasoning: "let the matrix tell the planner what to work on next so the title is predictable".

Rejected because:
- Couples test infrastructure into the runtime planner contract — exactly the kind of cross-cutting leak the architecture-first policy forbids.
- Requires Saivage code change for a P3 test-tooling issue.

## Contracts / schemas

- No changes to Saivage source, schemas, Zod contracts, or operator API.
- The only consumer of the new criterion is the audit subagent that executes `tmp/.../test-matrix.json`. The matrix's `pass_criteria` field is free-form prose; no schema constrains it.
- `T35.artifacts_to_capture` already lists `json:t35-cards.json` and `screenshot:t35-tree.png` ([tmp/.../test-matrix.json:949-950](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L949-L950)) — the new structural criterion consumes the same artefact, no new captures needed.

## Risks

- **None to runtime / users.** This is a test-matrix edit only.
- **Auditor-prompt update reach.** The matrix-authoring guideline must land in [prompts/saivage-v3-checkers-e2e-testing-instance.md](../../../../../prompts/saivage-v3-checkers-e2e-testing-instance.md) so the regression cannot re-enter via the next Phase-N authoring round. Mitigated by an explicit "do not literal-match planner output" rule added to that prompt.
- **In-flight artefact tmp/ location.** `tmp/` is workspace-local and not under saivage-v3's git tree; editing it does not require deployment. Plan reflects this.
