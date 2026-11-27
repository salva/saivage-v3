# Explicit work garbage collection

Use this optional operation to reclaim eligible ordinary scratch, captures and
webfetch stashes under `.saivage/work/`. It is not startup cleanup, canonical-state
repair, reset or migration. It never removes directories, publication temporaries,
attic, backups or canonical history. Deletion is irreversible and not transactional;
code rollback cannot recover files. Consider a separately prepared preserved backup
before destructive use. [Preview first](#preview-first-delete-separately); a later
delete needs separate authorization and makes a fresh selection. Preview requires
no backup. This operation does not replace the stopped/excluded/complete-backup gates for
[offline operations](./state-adoption.md).

Task-justified external command directories are outside `gc-work` coverage. Their
task owner handles owned cleanup and keeps needed evidence and its location clear
before disposal; this operation neither inventories nor collects those directories.

Retention follows current semantic use, not the union of historical references.
After separately authorized deletion, historical-only attachments/captures may be
irretrievably unavailable even though canonical card, record, conversation and
execution histories remain unchanged. Current content can protect concrete files
or directory subtrees in a specific card's work area, even if they are old.
Mentions of the work root, its ancestors, `cards`, a card root or its reserved
`tmp`/`processes` roots do not protect all files below them.
For example, `.saivage/work/cards/card-n/tmp/` does not preserve its contents,
but `.saivage/work/cards/card-n/tmp/foo` and `.saivage/work/cards/card-n/foo`
can protect that file or subtree. A specific capture directory under a card's
`processes` can also qualify. The rule applies to prose, structured paths and
locators, including bounded alias interpretations. Even a current exact Webfetch
`content_url` to global `tmp/stash`, or a running process's URL to a global
capture, does not protect those bytes. Otherwise eligible files can be deleted
while the URLs remain visible. Operational dependencies, unfinished execution
selections and process owners independently protect their selected scopes,
including applicable global files and roots. Commissioned
Git source roots are filters, not blanket work protection: a commissioned `.`
does not override the `.saivage` source exclusion. No reclamation or historical
availability is promised.

### Record a concrete dependency

In current content that GC uses, give the full locator of the needed file or
concrete directory, for example
`{"path":"work:///cards/card-n/tmp/foo/report.md"}`. In prose, delimit the
complete locator with backticks, or use a complete slash-bearing native path
such as `./logs/report.md`. In card content, GC tries that relative path under
the originating card's work root and its `tmp`, and nowhere else implicitly.
A filename such as `report.md` or a naked wildcard such as `*.md` is not a prose
reference, even in quotes.
A structured whole path field can carry a basename. An ordinary relative exact
path uses `cwd` when supplied, regardless of `directory`, and does not fall
back to the implicit bases if that `cwd` yields no bounded in-card target.
Scope metadata alone does not select a subtree. Use a complete locator when
the relative base is unclear. Global content has no implicit base, not even the
`project` card. From either card or global content, an explicit native path
like `./.saivage/work/cards/card-e/tmp/report.md` names that card using the project
root. A supported exact locator, an absolute path or a bounded alias can also
name a specific card other than the originating one.

A whole canonical `cardwork:///card-n/public/case%3F.ts` names `case?.ts`,
not its neighbors. In the same directory, `case%2A.ts` names `case*.ts` and
`case%253F.ts` names `case%3F.ts`. In structured content or a filesystem `glob`
call, a whole cardwork `pattern` is an exact suggestion independent of the match
scope. A logical `record:///` glob call contributes no work matcher or exact mark
from its pattern. Delimit a locator at the end of a sentence:
a trailing period in bare cardwork prose can be part of the filename. If a
cardwork locator appears inside a URL query value, encode the inner `%` again:
the inner `%3F` travels as `%253F` in that query.

For a relative structured matcher, GC uses `directory` first, then `cwd` if
`directory` is absent, then the implicit bases only if neither is supplied.
An explicit scope that cannot yield a bounded in-card match scope does not
fall back to the implicit bases. For example, pair `directory: "cardwork:///card-n/public"` with
`pattern: "case?.ts"` in structured content. In card content, `directory: "logs"`
with `pattern: "*.log"` searches the `logs` directories under the card work root
and card `tmp`; prose `reports/*.md` likewise has card-local bases. Neither
relative example has a base in global content. An explicit pattern such as
`./.saivage/work/cards/card-e/tmp/*.log` can work from either source.
`.saivage/work/cards/*/tmp/foo` and `work:///cards/**/foo` contribute nothing:
the fixed prefix must reach a specific card before the first wildcard.
GC resolves bounded lexical and alias spellings of an explicit scope with that
fixed prefix; it does not substitute a card-local default for an unresolved
directory. For example, an absolute alias to `cards/card-e/tmp/nested` paired
with `../*.log` can match logs directly under that card's `tmp`.

`*` and `?` stay within a segment; a whole `**` segment crosses levels. Matching
uses inventory names relative to the effective scope. GC starts counting if a
candidate file matches directly or through an ancestor, is not already marked
by the resolver, and is strictly older than `--before` if supplied. The card
horizon applies during final selection, not when deciding whether to count:
a file retained by its horizon can still open the count. GC counts distinct
matches, including recent and already protected entries.
Entries outside the scope and the scope itself do not count. Administrative
children can count without protecting anything. For example, `*` scoped to a
card root with 49 concrete children plus `tmp` counts 50: the concrete children
are marked, but an unmatched file under `tmp` does not gain protection. With
50 concrete children plus `tmp`, the count reaches 51 and the matcher marks
nothing. Zero matches also add nothing. At 1–50 matches a marked concrete
directory protects its subtree; an independent exact reference is unaffected
by the matcher cutoff.

Tool calls and their results can contribute separately under these advisory
rules. They do not change project-relative tool execution. A concrete explicit
in-card `grep.path` can protect a subtree even with a filename filter or empty
results. An omitted `grep.path` adds no subtree mark. `glob.directory`
supplies search scope, not subtree protection, though an explicit file there
can itself be protected. GC's ability to bound an advisory directory does not
mean the tool accepts it. Complete search-result paths are separate suggestions
as received; the 50/51 cutoff on the call's matcher is not a count of returned
items. A complete display can already have changed through normalization,
packing or redaction. GC neither reconstructs original bytes nor treats byte
slices as paths.

## Preview first, delete separately

Card `run_command` lazily creates `public` and `repos` under
`.saivage/work/cards/<card-id>/`. `SAIVAGE_CARD_PUBLIC_ROOT` and
`SAIVAGE_CARD_SHELL_ROOT` both name `public`. The two areas are ordinary concrete work.
Their existence does not protect files, though the card's compaction horizon and
other existing protections may. Old unprotected checkout files, including Git
metadata, can be reclaimed. A clone is not a backup. Prefer exact references to
needed artifacts or purpose-named subtrees rather than the whole area. GC keeps
directories; completion, re-entry and startup perform no automatic cleanup.
Task-owned explicit cleanup remains permitted; separately consented generated-state
reset includes the whole work root.

After [external pathname adoption](./state-adoption.md#card-workspace-pathname-adoption),
GC does not inventory the legacy `shell` symlink as another subtree. A recognized
exact old path such as `work:///cards/project/shell/install-check/result.ts` can
protect its resolved target. An exact scope `work:///cards/project/shell` paired
with the relative pattern `install-check/result.ts` resolves to the new directory,
subject to the usual matching rules. But `shell*/install-check/result.ts` under
`work:///cards/project` matches physical names, not aliases: it can stop protecting
the file now under `public`. A working legacy lookup is not proof of retention.
Assess reliance using only bounded, already-established evidence; do not scan
for unseen dependencies. If required work is known to rely solely on an old-name
glob for protection, block cutover unless a separately authorized normal current
reference protecting that work is established under the linked adoption procedure.

From the identified project root, using the matching release, preview with a
per-file minimum of 400000000 bytes and no optional cutoff or remaining-byte target:

```bash
saivage gc-work --dry-run --min-file-bytes 400000000
```

To also limit selection by age and aim for a remaining-byte target, preview the
combined filters:

```bash
saivage gc-work --dry-run --before 2026-10-01T00:00:00Z --min-file-bytes 400000000 --target-bytes 1073741824
```

After reviewing that preview, run a fresh delete only with separate authorization
and the applicable online or offline exclusion described below:

```bash
saivage gc-work --delete --before 2026-10-01T00:00:00Z --min-file-bytes 400000000 --target-bytes 1073741824
```

These are examples, not recommended universal retention thresholds. Omit `--before`
to remove the optional cutoff; the card horizon still applies. Otherwise it must be
RFC3339 with an explicit zone and regular-file **mtime must be strictly earlier**.
Equality/newer files remain.

`--min-file-bytes` tests each otherwise eligible regular file's inventoried
**logical length**, not allocated disk blocks or free space. A file exactly at the
minimum qualifies on size, unlike a file whose mtime equals the cutoff. Zero
allows empty files to qualify; omission leaves selection unfiltered by size.
Existing age, protection and fresh identity checks still apply.

`--target-bytes` is a best-effort target for **accounted logical bytes remaining**,
not a per-file minimum or desired bytes freed. Omit it to select all eligible
files. Oldest mtime comes first, with relative-path tie-break. Both byte options
take nonnegative safe integers.

For each reached live card, GC uses the minimum current compacted-genesis timestamp
across its unique configured card-session agents. An empty agent set, an established
empty session or ordinary genesis means no horizon and retains the entire card work
area. Otherwise a card file is eligible only strictly before both its horizon and
any supplied cutoff, and only without another protection. Horizon and no-horizon
retention count as `retained.protected`. Global work uses separate
cutoff and protection rules. Unreached or tombstoned card work stays opaque. The
clock is mtime, not access time or ctime; ctime is used for fresh identity checking.
Files introduced with preserved old mtimes can be deleted despite still being needed.

GC does not infer references from `run_command`'s `command`, `shell.run`'s
`config.script` (including literal wrappers in node actions and the
`afterActivationCommit` hook), execution scripts or launcher argv. It considers
`run_command`'s `cwd`, action cwd, artifacts, environment literals and literal
`inputs.args`, as well as configured MCP stdio program and argument values, under
their respective content or operational protection rules.
Explicitly shell-labelled Markdown fences (`sh`, `bash`, `shell`, `zsh`,
case-insensitive first info token) are masked using matching delimiters; an
unclosed fence masks the remaining body. Surrounding prose, unlabelled blocks,
inline backticks and non-shell text still receive ordinary inference, including
complete slash-bearing paths, supported locators and nested structured references.
Unlabelled snippets are not classified as shell; their lexical references can still
protect work. A file referenced only by excluded shell syntax can be deleted.

Omitting both effect flags is exactly `--dry-run`. Combining `--dry-run` and
`--delete` fails before a runtime request. An offline preview can also
[list the selected files](#list-selected-files-offline); `--list-files` cannot
be combined with `--delete`. Unknown options, invalid values and duplicate options
fail. There is no saved selection, preview replay or confirmation token. A later
delete always recomputes inventory, fresh references and final identity checks.
A qualifying in-card reference added since preview can protect a formerly
eligible file.

Neither preview nor an age cutoff proves selected files are unneeded. Prose
inference can miss a space-containing path in programming-language quote syntax
or a filename with line breaks. Decoded CR/LF quotations are inspected for nested
references rather than taken as one filename. Use a structured whole path or
an exact locator instead. If losing a file would be unacceptable, preserve it
separately before authorizing deletion. A delete can permanently remove needed
work missed by inference, discarded at the match cutoff, shown only in lossy
output, or referenced only by a global stash or capture URL. There is no estimated
error rate or rollback. This collection policy applies to a fresh invocation
using the changed collector. It requires no conversion or reset on matching
durable contracts. Source changes do not update an installed release or authorize
any live operation.

Without `--list-files`, the CLI delegates only through the verified live lifecycle
lock's published endpoint/auth mode. Listing refuses a verified live owner before
any HTTP request, even if project execution is stopped. Dead/malformed/indeterminate
ownership or, for delegation, an unavailable control endpoint refuses.
Only a missing lock selects the offline procedure below;
there is no fallback after delegation failure, endpoint rediscovery, lock
takeover, automatic start or Run. Bearer mode uses the existing private
`SAIVAGE_API_TOKEN` contract, never a URL token. See
[ownership outcomes](./runtime-control.md#five-ownership-outcomes).
Online collection requires an actually paused frontier or genuinely stopped project.
A running entry first requests pause; starting, closing, already-pausing or unresolved
ownership transitions refuse. Stopped entry creates no gate waiter, activation or Run.
Online shell background invocation is sufficient if desired; redirect output outside
work. There is no job-control API, agent tool or UI button, and a second
concurrent GC receives busy rejection.

## Observe an online collection

If output goes quiet, use a separate HTTP request to make one
`GET /api/runtime/gc-work/status` against the verified online control endpoint.
Check the installed release and the verified live owner's published endpoint
and auth mode; do not guess an address or follow redirects. Use the existing
operator bearer credential through your client's private `Authorization` header
handling. Keep it out of URLs, command arguments, shell history, traces and logs.
The diagnostic requires enabled bearer authentication; a server with authentication
disabled returns 403. Do not weaken or change authentication to make the request.
A bounded wait on this GET limits only the observation, not the collection.

In a 200 response, `active` describes the last checkpoint of the currently
observed task, even if the initiating POST drops progress or no stream is attached.
Within one admission, rising `counters.reference_visits` shows measured reference
work in 256-visit batches even when `counters.inspected_records` is flat. Those
visits are not completed records or matches. The GET has no admission identity:
samples alone cannot prove they came from the same invocation.
`elapsed_ms - last_checkpoint_elapsed_ms` is the age of the last checkpoint in
that snapshot. Only when the samples are known to be from the same admission,
compare `last_checkpoint_elapsed_ms` directly: a higher offset shows a newer
checkpoint, even if its age has grown. Checkpoint age does not tell you whether
GC has stalled or whether the named substep is still running. A `/health`
200 means only that HTTP answered. Synchronous work can delay HTTP observations.
See the [status contract](../spec/system-specification.md#online-work-gc-status).

If HTTP cannot answer, the fallback is a bounded, external, read-only process
observation. In the correct service namespace, verify the exact service unit
and its positive `MainPID` (for example, with
`systemctl show --property=Id,MainPID -- <verified-unit>`). If ownership is
unambiguous, take at most two `ps -p <pid> -o pid=,stat=,time=` samples a few
seconds apart and verify the same unit and process owner afterward. Do not read
argv, environment or logs, attach, profile or send signals. Process presence or
CPU movement does not establish GC advancement. Absence, changed or unknown
ownership, or a failed GET does not establish the prior outcome. Do not start
another collector, cancel, restart or inspect artifacts to settle that outcome.

`{"active":null}` means no task is currently observed, not that a particular
attempt finished or had no effects. Ordinary settlement clears status before
terminal delivery, so the initiating POST may still be draining. Only that POST's
valid terminal frame plus EOF establishes its reported outcome.

## Without a server owner

Stop the exact service, exclude automatic restarts and establish that no managed or
unrelated writer can affect this project throughout the command. Unknown writer
state must refuse. Both preview and delete require a terminal and the exact phrase
`GC OFFLINE QUIESCENT <canonical-project-root>` displayed by the CLI. Mistaken
exclusion can destroy needed data. There is no unattended confirmation flag.

After confirmation, the CLI exclusively acquires the existing **bound** lifecycle
lock with null endpoint; identity must already exist. It loads current configuration,
workflows and prompt closure and uses the same collector, without server/provider/MCP,
Git commissioning, init or recovery. Valid running cards, current unmatched calls
and unfinished native attempts stay unchanged and protect current selections. A missing
lock is not proof of process containment; safety depends on maintained operator
quiescence. Competing acquisition refuses, never reroutes. Preview also publishes
and releases this lock, but performs no collector file effects. Offline GC has no
status service. Its stderr progress is lossy; external process sampling cannot
recover a checkpoint. The normal final response is one stdout JSON line after
successful lock release; the listing mode below uses different streams.
Command death while holding the lock may leave an abandoned lock requiring the
separate manual procedure; never remove it automatically. Successful GC does not
certify whole-project startup compatibility or authorize start/Run.

### List selected files offline

To see which files an offline preview selected, run `saivage gc-work --list-files`
from the identified project root using the matching release. Dry-run is the
default; explicit `--dry-run` and any combination of `--before`, `--min-file-bytes`
and `--target-bytes` also work. The offline exclusion and exact terminal
acknowledgement above still apply.

To capture the list privately, set `private_dir` to an existing private directory
outside the managed project and choose a fresh filename there. Redirect only
stdout; leave stdin attached to the terminal and keep stderr visible or drained.

```bash
(umask 077; saivage gc-work --dry-run --list-files > "$private_dir/candidates.txt")
```

Treat the paths as private even when escaped. Do not forward the list to shared
logs. Check the command's exit status, not whether the file exists or looks
complete: redirection creates the file before GC runs.

Stdout contains only the files selected for hypothetical removal, in selection
order, one path relative to `.saivage/work` per LF-terminated line. Zero selected
files means empty stdout. Ordinary characters and spaces stay as they are;
literal backslashes are doubled. C0 and C1 controls (including DEL), Unicode
format controls, and line and paragraph separators use visible `\u{hex}` escapes
with lowercase hex digits (for example, `\u{a}` for a newline in a name).
These are path strings, not file contents or shell arguments.

The CLI starts the list only after completed selection, successful lock release
and prompt/signal cleanup. It checks stdout one line at a time. Disclosures, the
prompt and lossy progress stay on stderr. The CLI attempts to write the unchanged
final response JSON to stderr. For a completed preview, it does so only after
all stdout writes have succeeded. A noncompleted collection exits unsuccessfully
and emits no names.
If stdout delivery fails or is interrupted, the command exits unsuccessfully
without completion JSON; already written bytes can remain as an incomplete
prefix, even ending mid-line. Do not use such a prefix as a complete list.

Exit zero establishes completed selection, successful lock release and successful
writes to stdout. It does not prove stderr receipt, downstream consumption or
durable capture. An unread stderr pipe can delay exit even after lock release
and the last stdout line; handling a broken stderr pipe does not make stderr
nonblocking or give delivery a time limit. Progress counts are transient
observations, and the completed names describe only this preview. The list is
not a delete input: a separately authorized delete makes a fresh selection, which
may differ.

## What happens during either mode

1. Inventory yields between synchronous ordinary-work reads; online execution may
   continue during inventory. Candidate contents are not read; inventory is not deletion authority.
   Unknown categories, symlinks and ambiguous filesystem boundaries remain opaque.
2. Online, one private Supervisor hold rejects new Analyst submissions, independent
   mutations/MCP lifecycle calls and **all** Start/Resume sources. Accepted Analyst
   and external work finishes naturally; GC does not cancel their provider/tool
   work. Actual project parking (or genuinely stopped execution), complete owner settlement and the cancelled
   Oversight check precede marking. Already active independent HTTP MCP lifecycle
   calls/reconciliation refuse this attempt before pause, rather than being joined
   or automatically retried. Read-only views and project Stop remain available.
3. Fresh GC-only projections read current linked membership and selections, not
   predecessors, old segments or a complete history/native audit. Marking uses
   current card content and pending message bodies; selected record baseline, open
   draft and latest accepted content; current conversation effective summary,
   retained protected instruction contents and semantic source-row payloads; and
   unfinished execution artifact/capture/private-index selections. Existing retained
   process captures and operational dependencies also protect their existing scopes.
   Content file/directory and known alias references follow the concrete-artifact
   rule above.
   Historical content, internal observations and producer provenance
   alone do not. Required JSON, selections, framing, classifications and unfinished
   associations must decode; invalid required data refuses without truncation.
   Unrelated malformed fields in valid JSON need not refuse. Ordinary readers remain strict.
   Unresolved native source continuations refuse; GC performs no Git inspection,
   checkpoint or return to force settlement. Corrupt/missing required selections or torn tails refuse without repair.
   Unknown surviving process/service write footprints retain all potentially
   affected work or refuse collection; Pause is not an OS filesystem freeze.
   Unrelated human/program writers must be quiescent in the affected domain. Empty or
   entirely recent inventory or genuine whole-work protection can skip remaining
   projections; completion does not certify canonical integrity.
4. The same selection algorithm rechecks each exact candidate's identity, size,
   mtime/ctime, protections and cancellation immediately before its effect. Changed,
   replaced, disappeared or newly created files are not substituted or recrawled.
   Preview records hypothetical removals only; delete unlinks eligible regular
   files and accounts only known successes. Reserved `.saivage-tmp` entries are
   skipped before inspection/accounting, never collected.

GC itself writes no canonical rows, notices, manifests or durable reports, and
preview performs no collector file effects. Accepted operations can still finish
during settling and ordinary execution can resume afterward: preview does not make
the entire live application read-only. Offline collection instead uses the bound
lock and operator exclusion above. There is no GC elapsed maintenance/header/body/
total-request deadline or duration setting; connection establishment remains finite.
Nested extraction and candidate loops yield cooperatively, but individual synchronous
reads, JSON parsing and regex operations are indivisible. No cancellation latency
or throughput is promised. An unbounded content suggestion contributes no
protection and does not refuse GC. For example, a malformed `tmp:///project/bad%ZZ`
scope in a call or its diagnostic echo adds no fallback matches. GC does not guess
from `${base}/report.md` or follow an unresolvable alias to an assumed target.
It keeps independent bounded marks. Long or decoded multiline quotations do not
grant blanket protection; a complete, bounded reference found inside them can
still protect its own target.

## Results, cancellation and restoration

Progress goes to **stderr**, as concise newline-delimited text. Except in
[`--list-files` mode](#list-selected-files-offline), final **stdout** is exactly
one JSON response line after successful settlement (offline: after lock release).
Offline disclosure and the exact confirmation prompt also use stderr. For example,
redirect stdout to a result file outside work while watching stderr.
Observations are transient, lossy and throttled: phase changes emit immediately,
count updates at most once per second in existing work loops. There are no timers,
heartbeats, percentages, ETA or known total-work denominators. Slow/broken stderr
can drop observations. Dropping progress does not itself cancel collection or
suppress the final response.

POST progress frames and CLI stderr use `inventory`, online-only `settling`,
`retention_marking`, and `selection`. Inventory is not a settled hold; settling
describes an attempt to park/join owners, not completed exclusion. Offline initial configuration loading
still precedes inventory. Elapsed milliseconds use an operation-local monotonic
clock. Optional cumulative counts/logical bytes describe work already observed:
inventory's accounted files/opaque entries; completed necessary card, record and
session projections; classified candidates; hypothetical preview removals or
known-success deletions. Omitted means not yet observed/applicable; zero means
observed zero. They contain no paths, identities or content, and do not change
selection or certify completion. An indivisible synchronous read can be silent;
the last phase can include later settlement/release silence.
`inspected_cards` counts completed reached active cards, not tombstones;
`inspected_records` counts completed selected-record projections, not absent lazy
records; `inspected_sessions` counts completed necessary session projections. These
are not validation certificates. Inventory skips reserved temporary entries without counting them.

Every POST progress snapshot, active GET status and non-null final/partial result
includes `first_global_protection`: null or exactly `{reason,source}`. The first sufficient
global protection is retained for this attempt; it is neither the sole cause nor a
ranked cause, and encounter ordering need not be stable between attempts:

* `process_owner_uncertain`: process ownership has an unresolved footprint.
  Its source is `process_owner`.
* `operational_root`: an operational dependency selects work or an ancestor.
  Its source is `process_capture`, `unfinished_execution`, `workflow_input` or
  `operational_input`.

These fixed labels disclose no path,
card/session/record identity, token, content, object key, config value or exception.
CLI stderr renders, for example,
`first_global_protection=reason:process_owner_uncertain,source:process_owner`;
final JSON uses `"first_global_protection":{"reason":"process_owner_uncertain","source":"process_owner"}`.
Null is `first_global_protection=null` on stderr and JSON null in the response.
In progress or active status it means no global mark observed yet. Only a completed
result's null means none was established in the collection. Individual protections can still
cover every candidate with null. A non-null mark does not prove each file is
individually needed or exclude additional causes. Progress can be throttled/dropped;
a partial result is not completion, and `result:null` refusals do not fabricate a
mark even if earlier progress observed one. Attribution changes no retention,
validation, cancellation or fatal-publication boundary.

POST HTTP 200 is one `application/x-ndjson` stream with `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`: zero or more
`{type:'progress', progress: ...}` frames, exactly one last
`{type:'result', response: ...}` frame, newline terminated, then EOF. Each encoded
frame is bounded to 16 KiB including newline. Clients require strict schemas,
ordering, MIME and complete terminal-plus-EOF; no JSON-200 fallback exists.
Authentication/input/busy errors before stream admission remain JSON 401/400/409;
ordinary pre-stream internal failure is safe JSON 500. A post-header failure can
leave an incomplete stream instead. Ship matching server and clients together.
Slow clients drop optional progress; terminal drainage happens only after GC and
its hold release, never holding maintenance open for delivery.

The terminal response carries `mode`, `disposition` (`completed`,
`interrupted`, `refused`), `reason`, `restoration`, nullable `failure` and nullable `result`.
`completed` does not mean every file was eligible or the target was reached.

A required address that GC cannot bound stops collection before selection or
deletion. Without cancellation, the response is `disposition: refused`,
`reason: reference_scope_unresolved` and `result: null`. Cancellation takes
precedence: if it wins, the response instead has `reason: cancelled` and
`failure: null`. A cancelled response does not rule out an unresolved reference.
The required address can be an operational dependency (for example, an unresolved
alias for a compiled action's cwd) or the cardwork destination of a successful
`write` receipt (`data.target`) or workspace-file `webfetch` receipt (both
`data.saved_as` and `data.write.data.target`), tagged on that row as executed
and as a cardwork destination. Required resolution does not grant any additional
marking authority. A missing suffix below a known ancestor
is not itself unresolved. Unlike completed whole-work protection, this refusal
has no accounting result. In both the refusal and cancellation outcomes,
`restoration` reports what actually happened to execution. Failed calls and
untagged displays cannot require this refusal
just by quoting a path.

`failure` is null for completion and cancellation. Other ordinary failures expose
only `{code, syscall}`: code is one of `EACCES`, `EPERM`, `ENOENT`, `ENOTDIR`,
`EISDIR`, `ENAMETOOLONG`, `ELOOP`, `EMFILE`, `ENFILE`, `ENOSPC`, `EROFS`, `EIO`,
or `unknown`; syscall is one of `scandir`, `readdir`, `lstat`, `stat`, `realpath`,
`open`, `read`, `close`, or null. These are independently allowlisted original
metadata, never inferred from error text. No message, stack, path, identity or
nested cause is returned. `reason` gives the coarse stage; `unknown`/null means
safe metadata was unavailable, not that the failure is harmless. Semantic validation
errors can remain `unknown`.

For separately scoped diagnosis, permission codes (`EACCES`/`EPERM`) point toward
access checks; `ENOENT`/`ENOTDIR`/`EISDIR` toward missing or wrong-type required
data; `ENAMETOOLONG`/`ELOOP` toward path length or resolution loops;
`EMFILE`/`ENFILE` toward descriptor limits; and `ENOSPC`/`EROFS`/`EIO` toward
storage capacity, read-only storage or I/O. These labels do not identify the failed
file or prove a root cause. Do not automatically retry deletion, change permissions,
bypass protections, modify history or launch another live sweep to obtain details.

* `observed_count` / `observed_logical_bytes` describe the phase-1 accounted
  regular files, not a coherent current snapshot. `opaque_entries` does not count
  descendants or measure excluded bytes; `whole_work_size_known` is always false.
* `retained` counts accounted candidates by `protected`, `recent`, `stale`,
  `opaque`, `target` (eligible but not needed), or `below_min_file_bytes`
  (otherwise eligible but smaller than the minimum). Existing protection, opacity,
  age and fresh identity checks take precedence over the minimum, which is checked
  before the target. Whenever a minimum was requested, every non-null result
  (including a known partial result) includes this count, even if zero. Without
  a minimum, the count is omitted.
* Preview reports `would_delete_count` / `would_delete_logical_bytes`, with actual
  deleted fields zero. Delete reports `deleted_count` / `deleted_logical_bytes`,
  with hypothetical fields zero. A known partial result is not a rollback; failure
  attribution does not reconstruct or enlarge those known effect counts.
* `expected_accounted_logical_bytes_remaining` subtracts hypothetical or known
  removals from observed bytes. `accounted_target_shortfall` is null without a
  target, otherwise the remaining accounted excess. Undersized files still count
  toward remaining bytes and can leave a shortfall even after all eligible files
  have been selected. Zero shortfall does **not** certify whole-work size,
  physical blocks or free space. Opaque/new/changed files
  leave actual totals unknown; conservative protection may yield no reclamation.

On success or known failure/cancellation, only GC may restore the pause it initiated
on the same Run (`restoration: resumed`). Already-paused stays paused; stopped and
offline stay stopped (`not_resumed` after exclusion). Any ordinary
Pause withdraws auto-resume intent; Stop/server close/restart or natural Run
settlement defeats it. Public Start/Resume cannot release the hold. `not_resumed`
and `not_acquired` are not instructions to start a new Run: inspect current state.

Requester disconnect or Stop cancels online GC; CLI SIGINT/SIGTERM forwards
cancellation online and cancels offline collection cooperatively. During offline
list delivery, after release, SIGINT/SIGTERM instead interrupts the process.
Cancellation stops waiting for accepted Analyst work, not that work itself; collection
must actually settle before release. First failure ends the attempt, without retry,
compensation or repeat unlink. Publication/deletion-durability uncertainty is fatal
**before** readback, logging/report updates, cleanup, hold/lock release or resume.
Lifecycle release uncertainty is also fatal before output or further cleanup. A lost
response, malformed stream or missing terminal/EOF is not proof that nothing was
deleted. Transport failure prints no manufactured final stdout response; never replay it as a saved request
or infer lossless recovery. Follow [uncertainty handling](./state-adoption.md#stop-on-uncertainty).

The [operator API reference](../architecture/system-architecture.md#operator-routes)
and [configuration reference](../reference/configuration.md#explicit-work-gc-inputs)
describe collection and status. Using this optional command changes no
durable format and authorizes no automatic collection or live deployment.
