# Post-completion evidence/status persistence policy — source/spec root cause

Access date: 2026-06-01. This note is metadata/source-policy only: it does not copy raw live card/event bodies, logs, HTTP bodies, secrets, or lesson content.

## Executive summary

- **Final backlog completion evidence is expected to live on cards/events in current v3 source, not in `.saivage/diaries/` or `.saivage/reviews/by-goal/`.** The runtime reviewer path builds a `ReviewAssessment`, embeds it into the goal card result via `persistReviewState`, emits `review_complete` / `goal_completed` events, and updates runtime activation state. It does **not** call the diary/review-index API in `src/cards/diary.ts`.
- **Absent diary/review files are therefore expected under the currently implemented runtime path**, but this is a **source-policy mismatch / likely evidence-surfacing bug** if the operational contract requires persisted file-count evidence under `.saivage/diaries/` and `.saivage/reviews/by-goal/` after a reviewed goal completes. The API exists and is tested, but it is not wired into runtime reviewer completion.
- **`curriculum.md` non-refresh after a lesson card completes is expected behavior unless v3 changed the curriculum itself.** The binding spec says `curriculum.md` is the authoritative v3-maintained topic list and is reconciled with backlog/catalog. It requires catalog/backlog updates after generation, but does not require touching curriculum on every produced lesson.
- **`pipeline-status.md`, `backlog.md`, and `catalog.md` refresh after lesson generation are spec-aligned.** SPEC §5 says lesson generation records `lesson_hash`, `diedrico_commit_sha`, and updates catalog/backlog; SPEC §6 says tooling blocks are reported via pipeline-status. The source has no typed first-class module for these product markdown surfaces; they are v3 product files edited by agents/tools rather than by a central runtime persistence function.
- **No source policy found that would imply terminal-tool/authz/cancellation failures should recur after this completion.** Those are runtime/planner failure paths independent of review/diary file creation and product markdown refresh.

## Binding spec policy for product/status surfaces

Sources:
- `/work/diedrico-lessons/SPEC.md`, accessed 2026-06-01 (scanned by line number only in `t2-spec-policy-scan.stdout.log`).
- `/work/diedrico-lessons/proposals/spec-amendment-001-v3-runtime-shape.md`, accessed 2026-06-01.

Relevant policy facts:

| Surface | Spec owner/purpose | Post-completion implication |
|---|---|---|
| `curriculum.md` | v3-owned authoritative dihedral-method curriculum; entries carry categories `tool-intro`, `method-intro`, `exercise` (SPEC lines 277-293). | Must exist and be maintained/reconciled, but no requirement to update mtime after every lesson unless curriculum coverage/content changes. |
| `backlog.md` | v3-owned ordered queue; each cycle cross-references curriculum with catalog/backlog and selects uncovered supported topics (SPEC lines 298-300). | Expected to refresh when generated work is removed/reordered or new upcoming work is queued. |
| `catalog.md` | v3-owned index of produced lessons (SPEC line 198). | Expected to refresh when a lesson is produced or regenerated. |
| `pipeline-status.md` | v3-owned current pipeline state; v2 reads, never writes (SPEC lines 200-201). Missing tooling is reported under a `Blocked on tooling` section (SPEC lines 354-358). | Expected to refresh when v3 records pipeline state/tooling blocks; not a v2/manual edit surface. |
| `.saivage/diaries/`, `.saivage/reviews/` | Amendment 001 says these are v3 internal layout directories produced by `initProjectTree` (amendment line 16). | The amendment establishes layout ownership, not a product-level requirement that every goal completion must create diary/review files. |

SPEC §5 also states that lesson generation updates `catalog.md` and `backlog.md` after recording lesson metadata (line 323-324 in the scan). It does not say `curriculum.md` must be rewritten on each lesson completion.

## Source policy: diaries/reviews

### Directory/API exists

`src/persistence/file-tree.ts` creates the internal directories:

- `SAIVAGE_DIRS` includes `diaries` and `reviews/by-goal` at lines 100-107.
- `initProjectTree` creates these directories at lines 206-214.

`src/cards/diary.ts` implements a concrete persistence API:

- `appendDiaryEntry(...)` writes `.saivage/diaries/<goalId>/<sequence>.<kind>.json` and updates `.saivage/diaries/<goalId>/index.json` (lines 138-185).
- `appendReviewAssessment(...)` embeds a review assessment in a diary entry and updates `.saivage/reviews/by-goal/<goalId>.json` (lines 241-292).
- Tests under `tests/utils/diary.test.ts` cover diary and review-index behavior (see `t2-layout-grep.stdout.log`).

### Runtime reviewed completion path does not use that API

The active runtime reviewer path is in `src/runtime/runtime.ts`:

1. `nextReviewerAssessmentId`, `reviewerSessionId`, `buildReviewAssessment`, and `validateReviewerAssessment` define assessment IDs and validate cited evidence (lines 1181-1251).
2. `persistReviewState(goalId, assessment)` updates the goal card `result.review` only (lines 1254-1259).
3. When planner work is done, runtime invokes reviewer (lines 2803-2813). On reviewer invocation failure it blocks the goal and records planner failure metadata (lines 2814-2849).
4. On reviewer pass, runtime transitions the goal to done if needed, builds the assessment, calls `persistReviewState`, updates `completed_at` and planning summary, appends the activation unwind result, emits `goal_completed`, and appends a `goal_completed` event (lines 2880-2915).
5. On reviewer needs-corrections or invalid pass, runtime calls `persistReviewState` and emits/appends `review_failed` (lines 2851-2878 and 2916-2930).

A focused source grep found no `appendReviewAssessment`/`appendDiaryEntry` call from `src/runtime/runtime.ts`, `src/tools/planner-tools.ts`, or the live reviewer completion path. `src/tools/planner-tools.ts` has a separate older/utility `PlannerToolsService` path that also embeds `result.review` and accepts reports, but does not call the diary module.

### Classification

- **Current-source expected behavior:** `.saivage/diaries/` and `.saivage/reviews/by-goal/` can remain empty after a reviewed goal/card completes because runtime persists reviewer evidence into card JSON and runtime events, not the diary/review-index directories.
- **Likely bug if external acceptance requires file-count evidence:** the existence of `src/cards/diary.ts`, tests, and initialized directories suggests intended durable review/diary indexes, but the reviewed completion path bypasses them. A minimal v3-side fix would be to call `appendReviewAssessment(join(projectRoot, '.saivage'), assessment)` whenever `persistReviewState` records a `ReviewAssessment`, ideally idempotently to avoid duplicate entries on retry/restart.
- **Risk:** since current runtime writes review assessment into `card.result.review` and events, adding diary/index persistence should be treated as an evidence-surfacing/backfill improvement, not as a reason to re-run lesson production or edit lesson/product markdown manually.

## Source/spec policy: curriculum, backlog, catalog, pipeline-status

There is no central typed v3 source module dedicated to `curriculum.md`, `backlog.md`, `catalog.md`, or `pipeline-status.md` updates. Grep found references mainly in docs/spec/tests, not in runtime code. These files are v3-owned product/status markdown surfaces that agents update through workspace/file tools under SPEC constraints.

Classification by surface:

- **`catalog.md`: expected to refresh when a lesson completes.** SPEC §5 says lesson generation records lesson metadata and updates `catalog.md` and `backlog.md`.
- **`backlog.md`: expected to refresh when completed work changes the ordered queue.** A final backlog completion commonly removes/reconciles an item or leaves it empty/at rest.
- **`pipeline-status.md`: expected to refresh when v3 records current pipeline state or tooling blocks.** Cycle-042 observed it refreshed by mtime, which is consistent with v3 status reporting.
- **`curriculum.md`: non-refresh is expected when no curriculum entry is added/changed.** SPEC makes it authoritative input/coverage state, but not a per-lesson completion log.

## Current stage classification answers

| Question | Classification | Evidence/policy basis |
|---|---|---|
| Final backlog completion | Completed by prior live metadata; source policy only reviewed here. | Cycle-042 summary says target card status advanced to done and status surfaces refreshed. |
| Product/status refresh | `pipeline-status.md`, `backlog.md`, `catalog.md` refresh is expected after final lesson/card completion; do not edit manually. | SPEC §5/§6 ownership and update requirements. |
| Curriculum non-refresh | Expected behavior if no curriculum content/reconciliation changed. | SPEC requires maintaining/reconciling curriculum, not rewriting it on every lesson. |
| Review/diary evidence absence | Expected under current implementation, but likely an evidence-surfacing bug if `.saivage/reviews`/`diaries` file-count evidence is mandatory. | Runtime `persistReviewState` embeds review in card result; diary API exists but no runtime callsite. |
| Root/runtime state | No source policy found tying this issue to active root/runtime failures. | Review/diary file absence is independent from scheduler terminal-tool/authz/cancellation paths. |
| Terminal-tool/authz/cancellation recurrence | No evidence in source policy that these should recur due to the final completion refresh gap. | Those are separate planner/tool authorization and state-machine paths. |

## Minimal fix guidance if Manager chooses to treat absent file evidence as a bug

1. Wire `src/runtime/runtime.ts` `persistReviewState` to append review assessment into `.saivage/reviews/by-goal/<goalId>.json` and `.saivage/diaries/<goalId>/...` via `appendReviewAssessment`.
2. Make the write idempotent by assessment ID/session ID or by checking existing review index before appending; runtime retries/restarts can otherwise duplicate entries.
3. Add a focused regression test that completes a goal with reviewer pass and asserts:
   - `card.result.review` remains present;
   - `.saivage/reviews/by-goal/<goalId>.json` exists and references one review;
   - `.saivage/diaries/<goalId>/index.json` and one `review_assessment` entry exist;
   - no product markdown (`pipeline-status.md`, `backlog.md`, `catalog.md`, `curriculum.md`) is manually changed by the test.
4. No Diedrico or lesson-product edits are needed for this fix.

## Sources and local evidence artifacts

- `/work/diedrico-lessons/SPEC.md`, accessed 2026-06-01; line scan stored at `.saivage/stages/repair-post-final-backlog-completion-refresh-and-evidence/reports/t2-spec-policy-scan.stdout.log`.
- `/work/diedrico-lessons/proposals/spec-amendment-001-v3-runtime-shape.md`, accessed 2026-06-01; line scan stored with the same spec scan artifact.
- `/work/saivage-v3/src/runtime/runtime.ts`, accessed 2026-06-01; key ranges captured in `t2-runtime-reviewer-keyranges.stdout.log` and `t2-runtime-review-pass-branch.stdout.log`.
- `/work/saivage-v3/src/cards/diary.ts`, accessed 2026-06-01; key ranges captured in `t2-diary-keyranges.stdout.log`.
- `/work/saivage-v3/src/persistence/file-tree.ts`, accessed 2026-06-01; key ranges captured in `t2-file-tree-keyranges.stdout.log`.
- `/work/saivage-v3/src/tools/planner-tools.ts`, accessed 2026-06-01; key ranges captured in `t2-planner-tools-keyranges.stdout.log`.
