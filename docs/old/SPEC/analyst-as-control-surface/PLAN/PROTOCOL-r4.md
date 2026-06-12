# Stage Publication Protocol — r4

This protocol supersedes all earlier revisions. r4 drops the revision recipe entirely: a published stage is immutable. Any fix is delivered as a new stage with a higher numeric prefix.

## 1. Purpose

Make stage specifications visible to the Saivage v2-on-v3 autonomous instance one stage at a time, atomically, immutably, and with a single primitive (atomic directory rename on the same filesystem).

## 2. On-disk layout

```
saivage-v3/SPEC/analyst-as-control-surface/PLAN/
  00-MASTER-PLAN-r<n>.md
  PROTOCOL-r4.md            (this document)
  drafts/                   (work-in-progress; consumer ignores)
  stages/                   (published; consumer watches; immutable)
    001-llm-resolver-real/
      design.md
      plan.md
    002-tool-surface-alignment/
      design.md
      plan.md
    ...
```

The published directory is exactly [saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/). Its immediate children are stage directories named `NNN-<slug>` where `NNN` is a zero-padded three-digit decimal integer used as a sort key and `<slug>` is short kebab-case `[a-z0-9]+(-[a-z0-9]+)*`. Each stage directory contains exactly the definitive documents for that stage: at minimum `design.md` and `plan.md`; additional files (assets, diagrams) are permitted only inside the stage directory.

The drafts directory `drafts/` holds work-in-progress; the consumer ignores it. Authors may equivalently build a stage in any path outside `stages/` (for example workspace `tmp/`) provided that path is on the same filesystem as `stages/`.

## 3. Publication primitive

A stage is published in exactly one step:

1. Build the complete stage directory at a path outside `stages/` on the same filesystem (POSIX `rename(2)` is atomic only across the same filesystem). Place all definitive files inside it; do not place anything else.
2. Atomically move the directory into `stages/` with `rename(2)` (shell `mv`), giving it its final name `NNN-<slug>`.

Both endpoints of the rename must reside on the same filesystem. If `drafts/` is the build location, this is satisfied automatically because `drafts/` is a sibling of `stages/`. If the build location is elsewhere (for example `tmp/`), the author must verify `stat -c '%d' tmp /home/salva/g/ml/saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages` reports the same device number before the move; otherwise the move would be a copy-then-unlink and not atomic.

The consumer either sees the stage with all of its files, or does not see it at all. There is no intermediate state.

## 4. Immutability

Once a stage directory is inside `stages/`, neither its name nor any byte under it may change. There is no revision flow. There is no withdrawal flow. There is no "fix in place".

If a published stage is wrong, the correction is published as a new stage at the next free `NNN` prefix. The new stage's `design.md` and `plan.md` describe the correction relative to whatever they need to address; the master plan and the analyst running in v2-on-v3 are responsible for resolving the ordering and supersession in human terms. The protocol itself does not model supersession.

Authors who realise a stage is wrong before the consumer has picked it up MUST still publish the correction as a new stage. They MUST NOT mutate the published directory.

## 5. Consumer rules

The consumer is the Saivage v2-on-v3 autonomous instance. It owns its own queue and a persistent record of which stage names it has already enqueued.

1. The watched directory is exactly [saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/). Only immediate children whose name matches the strict regex `^[0-9]{3}-[a-z0-9]+(-[a-z0-9]+)*$` are considered. Anything else (including dot-prefixed names, names with uppercase, names with underscores) is ignored.
2. The consumer scans for new stages when its queue empties. There is no scan cadence requirement. An operator can also poke the consumer through its interface to force a scan.
3. New stages (those whose directory name is not already in the persistent enqueued-set) are sorted by name (lexicographic over the regex-matched names; equivalent to numeric on the `NNN` prefix) ascending and appended to the queue in that order.
4. The persistent enqueued-set is updated under the same durability guarantees the consumer applies to its queue. A stage MUST be recorded as enqueued before or atomically with its appearance in the queue, so a crash mid-scan cannot produce a duplicate on resume. The mechanism is a consumer implementation detail; this protocol only states the invariant.
5. The consumer reads the documents of a discovered stage by reading the files directly. There is no sentinel to consult and no integrity check to perform: Section 3 (atomic rename) and Section 4 (immutability) together guarantee the directory is complete and stable.

## 6. Things this protocol intentionally does not define

- No revision recipe, no withdrawal recipe. Section 4 is final.
- No file digest, no manifest, no version field, no dependency declaration. Stage `NNN` prefix is purely a sort key.
- No supersession semantics. Supersession lives in human prose inside the master plan and the affected stages' `design.md` / `plan.md`.
- No format constraint on the stage documents beyond their filenames. The master plan governs required content.
- No protocol versioning policy for itself. When this protocol changes it is replaced wholesale per the workspace architecture-first rule.

ROUND: 4
