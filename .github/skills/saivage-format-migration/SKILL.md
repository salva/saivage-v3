---
name: saivage-format-migration
description: 'Migrate a Saivage deployment's retained generated state across a reset-only durable-format cutover without losing history: offline reconstruction into the current formats via a validated separate candidate. Use when adopting a newer Saivage binary generation whose format changes forbid same-format rollout and the owner explicitly requires preserving cards, records, and conversations instead of resetting to an empty tree.'
---

# Saivage Generated-State Format Migration

History-preserving adoption of a newer Saivage format generation. This is the
AGENTS.md Storage Policy exceptional offline reconstruction, executed as an
operator procedure. It is **not** a product capability: no migration code,
compatibility reader, or normalization enters the Saivage source tree. All
tooling is a one-off script under workspace `tmp/`, never committed.

## When to use

- A deployment must adopt a newer Saivage release whose durable formats changed
  (reset-only cutover), AND
- the owner explicitly requires preserving the retained card tree, records, and
  conversation history (no empty-tree reset), AND
- the owner has given explicit scoped authorization for the irreversible-risk
  boundary (AGENTS.md "Project Owner Overrides" / exceptional reconstruction
  contract: consequences stated and confirmed).

If a same-format rollout suffices (no durable format in the drift), use the
ordinary stop/deploy/start procedure instead — never this one.

## Authority and invariants

- Authorization must be explicit and separate from deploy approval; state the
  concrete consequence (candidate is new reconstructed state with no byte,
  historical, forensic, or audit equivalence to the original) and get
  confirmation.
- The service must be stopped and positively owner-free before any mutation.
- A complete stopped backup of the whole target project is mandatory and must
  succeed before any inspection or mutation; it is preserved unchanged and is
  never a workspace or authority.
- The candidate is authored wholly separate (workspace tmp); the installation
  and backup are never edited in place; cutover replaces the complete
  applicable generated-state boundary (the four roots) plus enumerated
  operator inputs.
- Strict validation of the complete candidate against the NEW release's own
  compiled code must pass before cutover; any failure blocks cutover and
  authorizes no relaxation.
- Orphans and aside copies left by interrupted swaps are harmless noncanonical
  artifacts — never discovered, cleaned, or adopted by the procedure.
- Report source, scope, validation, omissions, uncertainties, and
  transformations in an external non-authoritative report outside both the
  backup and generated state.

## Procedure

1. **Format-delta analysis (read-only).** Between deployed revision and target
   revision, enumerate every durable and consumed contract change: card
   streams (artifact format versions, record fields, transition deltas),
   conversation envelope/index/genesis versions, per-row context-policy
   fields, compaction commitments and their hash cascade, config schema
   (prompt declarations etc.), tool-result payload shapes consumed at
   projection time (not just at startup), app-log lanes, record formats,
   prompt content, work/URL layout. Produce a written migration SPEC with
   exact old/new shapes and transformation rules per artifact. Pay special
   attention to poisons that fail not at startup but at next use (e.g. old
   tool-result payloads thrown by the provider-composition projector).

2. **Build the target release** (isolated copy, Node 24, `npm ci` + `build` +
   docs/typecheck gates), verified by archive SHA and tree manifest. Pin the
   exact commit; exclude unrelated in-flight work by building from `git
   archive <rev>`.

3. **Construct the candidate.** One-off script in tmp importing the NEW
   release's compiled validators and canonical helpers (canonicalJson, hash
   helpers, conversation readers, redaction/certified-prefix functions) —
   never reimplement validators; pure replication only for unexported
   helpers, noted in the report. Copy the retained `.saivage` into
   `candidate/` and transform only the copy. Order transformations so
   content rewrites precede commitment-hash recomputation; cascade
   cross-segment commitments (e.g. priorHistoryHash) so every commitment is
   exact. On any validation issue: fix the script and REGENERATE from a
   fresh copy — never patch a candidate partially.

4. **Validate all gates with the new release's compiled code:**
   config `loadEffective()`; generated-state startup initialization; every
   selected global participant's conversation validation; strict read of
   EVERY conversation segment including historical versions; provider
   composition dry-run over every canonical row of every current segment
   (zero throws). All must pass.

5. **Cutover** (still stopped, owner-free reconfirmed, backup + candidate
   manifests re-verified): install the release to a fresh private path;
   swap the four generated roots wholesale plus the enumerated config/prompt
   inputs (staged-copy-then-swap; keep live credentials/identity untouched);
   update only the service release-path override; start ONCE. Startup failure
   leaves the service stopped and is reported — no repair, retry, or
   improvised rollback.

6. **Resume and verify:** one ordinary Run; confirm the SAME tree resumes
   (card counts, history identity, prior active chain recovering through
   full-chain STOPPED recovery), fresh provider exchanges succeed, and no
   empty tree or re-derived objectives.

7. **Report** transformations, counts, caveats (dropped unrepresentable rows,
   missing work outputs, lost legacy prompt protection, version-renumbering
   side effects), gate evidence, and exact artifacts/manifests.

## Prohibitions

No product-source migrations or compatibility readers; no partial candidate
patching; no inspection/repair of canonical streams beyond the enumerated
transformations; no orphan discovery or cleanup; no mixing: the old binary
never runs against new-format state and the new binary never legitimizes
old-format rows; the one-off script and reports stay out of Git.

## Relationship to other skills

`saivage-project-reset` is the destructive path (empty tree). This skill is
the history-preserving alternative for the same cutover situations.
`saivage-lxc-operations` governs service stop/start/lock classification used
throughout.
