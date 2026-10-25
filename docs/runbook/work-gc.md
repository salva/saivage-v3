# Explicit work garbage collection

Use this optional operation to reclaim unreferenced ordinary scratch, captures and
webfetch stashes under `.saivage/work/`. It is not startup cleanup, canonical-state
repair, reset or migration. It never removes directories, publication temporaries,
attic, backups or canonical history. Deletion is irreversible and not transactional;
code rollback cannot recover files. Consider a separately prepared preserved backup
before destructive use. Preview requires no backup. This live operation does not
replace the stopped/excluded/complete-backup gates for
[offline operations](./state-adoption.md).

Task-justified external command directories are outside `gc-work` coverage. Their
task owner handles owned cleanup and keeps needed evidence and its location clear
before disposal; this operation neither inventories nor collects those directories.

## Preview first, delete separately

From the identified project root, using the matching release:

```bash
saivage gc-work --dry-run --before 2026-10-01T00:00:00Z --target-bytes 1073741824
# After reviewing the result, explicitly request a NEW selection:
saivage gc-work --delete --before 2026-10-01T00:00:00Z --target-bytes 1073741824
```

These are examples, not recommended universal retention thresholds. Omit `--before`
for no age restriction; otherwise it must be RFC3339 with an explicit zone and
regular-file **mtime must be strictly earlier**. Equality/newer files remain.
`--target-bytes` is an optional nonnegative safe integer: a best-effort remaining
**accounted logical-byte** target, not desired bytes freed. Omit it to select all
eligible files. Oldest mtime comes first, with relative-path tie-break.

Omitting both effect flags is exactly `--dry-run`. Combining `--dry-run` and
`--delete` fails before a runtime request. Unknown options/invalid values fail;
there is no saved selection, preview replay or confirmation token. The later delete
always recomputes inventory, fresh references and final identity checks. A reference
added since preview can protect a formerly eligible file.

The CLI delegates only through the verified live lifecycle lock's published
endpoint/auth mode. Missing/dead/malformed/indeterminate ownership or an unavailable
control endpoint refuses; there is no offline fallback, endpoint rediscovery, lock
takeover, automatic start or Run. Bearer mode uses the existing private
`SAIVAGE_API_TOKEN` contract, never a URL token. See
[ownership outcomes](./runtime-control.md#five-ownership-outcomes).
An existing **running or fully paused Run** is required for maintenance; stopped,
starting, stopping or already-pausing execution refuses. Ordinary shell background
invocation is sufficient if desired; redirect output outside work. There is no job
API, agent tool or UI button, and a second concurrent GC receives busy rejection.

## What happens during either mode

1. Inventory yields between synchronous ordinary-work reads while execution
   continues. Candidate contents are not read; inventory is not deletion authority.
   Unknown categories, symlinks and ambiguous filesystem boundaries remain opaque.
2. One private Supervisor hold rejects new Analyst submissions, independent
   mutations/MCP lifecycle calls and **all** Start/Resume sources. Accepted Analyst
   and external work finishes naturally; GC does not cancel their provider/tool
   work. Actual project parking, complete owner settlement and the cancelled
   Oversight check precede marking. Already active independent HTTP MCP lifecycle
   calls/reconciliation refuse this attempt before pause, rather than being joined
   or automatically retried. Read-only views and project Stop remain available.
3. Fresh strict canonical reads protect references in current/linked history,
   baseline/draft/accepted records, all indexed conversation segments (including
   pre-compaction originals), raw tool results, pending messages and execution
   evidence. Directory/alias references and operational dependencies also protect
   work. Corrupt/missing required evidence or torn tails refuse without repair.
   Unknown surviving process/service write footprints retain all potentially
   affected work or refuse collection; Pause is not an OS filesystem freeze.
   Unrelated human/program writers must be quiescent in the affected domain.
4. The same selection algorithm rechecks each exact candidate's identity, size,
   mtime/ctime, protections and cancellation immediately before its effect. Changed,
   replaced, disappeared or newly created files are not substituted or recrawled.
   Preview records hypothetical removals only; delete unlinks eligible regular
   files and accounts only known successes. Reserved `.saivage-tmp` entries are
   skipped before inspection/accounting, never collected.

GC itself writes no canonical rows, notices, manifests or durable reports, and
preview performs no collector file effects. Accepted operations can still finish
during settling and ordinary execution can resume afterward: preview does not make
the entire live application read-only. Maintenance has a one-minute cancellation
bound, not a hard pause-duration SLA; individual synchronous reads can take time.

## Results, cancellation and restoration

The CLI prints the bounded response: `mode`, `disposition` (`completed`,
`interrupted`, `refused`), `reason`, `restoration` and nullable `result`.
`completed` does not mean every file was eligible or the target was reached.

* `observed_count` / `observed_logical_bytes` describe the phase-1 accounted
  regular files, not a coherent current snapshot. `opaque_entries` does not count
  descendants or measure excluded bytes; `whole_work_size_known` is always false.
* `retained` counts accounted candidates by `protected`, `recent`, `stale`,
  `opaque` or `target` (eligible but not needed). Protections beat age/size.
* Preview reports `would_delete_count` / `would_delete_logical_bytes`, with actual
  deleted fields zero. Delete reports `deleted_count` / `deleted_logical_bytes`,
  with hypothetical fields zero. A known partial result is not a rollback.
* `expected_accounted_logical_bytes_remaining` subtracts hypothetical or known
  removals from observed bytes. `accounted_target_shortfall` is null without a
  target, otherwise the remaining accounted excess. Zero shortfall does **not**
  certify whole-work size, physical blocks or free space. Opaque/new/changed files
  leave actual totals unknown; conservative protection may yield no reclamation.

On success or known failure/cancellation, only GC may restore the pause it initiated
on the same Run (`restoration: resumed`). Already-paused stays paused. Any ordinary
Pause withdraws auto-resume intent; Stop/server close/restart or natural Run
settlement defeats it. Public Start/Resume cannot release the hold. `not_resumed`
and `not_acquired` are not instructions to start a new Run: inspect current state.

Requester disconnect, timeout or Stop cancels GC; timeout/disconnect stops waiting,
not accepted Analyst work. First failure ends the attempt, without retry,
compensation or repeat unlink. Publication/deletion-durability uncertainty is fatal
**before** readback, logging/report updates, cleanup, hold release or resume. A lost
response is not proof that nothing was deleted; never replay it as a saved request
or infer lossless recovery. Follow [uncertainty handling](./state-adoption.md#stop-on-uncertainty).

The [operator API reference](../architecture/system-architecture.md#operator-routes)
and [configuration reference](../reference/configuration.md#explicit-work-gc-inputs)
describe the singular request contract. Enabling this optional command changes no
durable format and authorizes no automatic collection or live deployment.
