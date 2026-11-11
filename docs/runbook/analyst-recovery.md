# Analyst runtime recovery

Resolve the user's requested outcome with current evidence and supported controls.
This optional runtime skill is named `analyst-runtime-recovery`; it grants no tools
or authority. Use selected tool definitions for exact arguments and admission.
It is for infrequent ambiguous failures or interruptions, not a checklist for
ordinary turns, an automatic recovery engine or source-delivery work.

## Establish what needs to happen

Identify the requested outcome, exact card/session and existing authorization.
Inspect current runtime/card state and only evidence relevant to that decision.
An existing request may already authorize a supported reopen and Run; do not
require ceremonial reconfirmation. DONE may correctly remain done.

For what failed, use `read_agent_session` diagnostic-first navigation and its
bound continuation instructions. Inspect exact message detail where needed;
original messages and segment context remain available for deeper investigation.
Do not dump configuration or page prepared prompts merely to answer what failed.
Protect credentials and other secrets throughout diagnosis and reporting.

Compare actual timestamps and parent call/result linkage with child activation,
tool and provider evidence. Distinguish authored status claims, retained terminal
results, refused admission and actual fresh execution. A parent narrative alone
does not establish a child attempt. Current-segment/tail coverage, truncation,
compacted context and synthesized notices limit conclusions: absence from a
bounded page does not prove no historical attempt. Working Analyst authentication
does not establish worker quota or route health.

## Choose the supported next action

- Stopped work uses authorized `start_project` (Run); settled-paused work uses
  authorized `resume_runtime` for that same Run. Running work needs no duplicate
  Start. Transitional/error states call for relevant state/diagnostic inspection,
  not repeated control calls.
- Start refusal `root_not_startable` identifies a terminal root. For FAILED or
  DONE, inspect current requirements and actual evidence; if authorized and
  intervention-ready, use selected Analyst `reopen_card`, then authorized Start.
  CANCELLED is not reopenable by this operation: ask for the intended disposition,
  not an automatic reset or replacement.
- `runtime_not_stopped` calls for state-appropriate Resume, no new Start, or
  diagnosis. `application_closing` belongs to the lifecycle owner.
  `entry_refused` may follow effects and retains its entry summary; do not describe
  every refusal as effect-free. Respect any uncertainty boundary before inspection.
- For a failed child, respect immediate-parent ownership and current lifecycle.
  Its Planner may reopen a DONE/FAILED direct child and then activate it;
  actionable BLOCKED can be activated without reopening. Analyst dormant-card
  intervention requires selected grants and stopped/settled-paused admission.
  Run activates root, not an old leaf automatically. Do not manually reconstruct
  a scheduler path or infer a new attempt from old failure text.

Use ordinary safe observations only where the current boundary permits them.
An interrupted or unknown-effect call proves neither success nor failure of its
effects: do not retry or replay it. Fatal publication uncertainty permits **no
follow-up inspection, read, write, retry or cleanup**. Escalate the actual
diagnostic and unknowns to the authorized lifecycle/development owner, without
claiming that a tool failure grants further authority.

## Act or hand off precisely

When evidence supports an already-authorized ordinary correction, perform the
supported operation and verify useful observable continuation at the requested
scope. Separate request acceptance, launch, actual fresh activity and completion;
successful Start alone is launch. If requirements, access or harness source block
progress, name that owner and a precise next action rather than repeatedly
summarizing the failure or attempting delivery work yourself.

Bounded diagnosis within selected capabilities is legitimate; it grants no source
delivery, harness patching/deployment or provider-safeguard evasion. Do not add
auto-reopen/retry loops, reset, migration, lock manipulation or a safeguard
workaround. Those are not ordinary continuation steps authorized by this skill.

## Availability and lifetime

Operators may explicitly copy this matching-release document into the runtime
catalog using the configuration guide's optional Analyst recovery skill recipe.
Installation or version updates do not provision it or adopt revised role overrides.
If it is absent/unavailable, say so when relevant and use current tool help and
essential role direction; do not fabricate a load, create files or repeatedly
try loading. Custom names/content remain operator-owned. Skill results use ordinary
conversation context, not permanent protection or automatic reload after compaction;
load again on a later request if needed detail is no longer in effective context.
