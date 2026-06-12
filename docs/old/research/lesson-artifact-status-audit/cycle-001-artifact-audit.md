# Cycle 001 lesson artifact status audit

Access date: 2026-05-31

## Scope and sources

This audit compares the cycle-001 lesson outputs for `001-orienting-to-the-diedrico-workspace` against the binding lesson artifact contract in `/work/diedrico-lessons/SPEC.md` and against the previous task report at `.saivage/stages/lesson-cycle-001-pipeline-bootstrap/reports/t2-bootstrap-lessons-pipeline.json`.

Sources inspected:

- `/work/diedrico-lessons/SPEC.md` (read-only; not edited)
- `/work/saivage-v3/.saivage/stages/lesson-cycle-001-pipeline-bootstrap/reports/t2-bootstrap-lessons-pipeline.json`
- `/work/diedrico-lessons/catalog.md`
- `/work/diedrico-lessons/backlog.md`
- `/work/diedrico-lessons/lessons/001-orienting-to-the-diedrico-workspace/`
- Captured command outputs for this audit:
  - `.saivage/stages/lesson-cycle-002-bootstrap-recovery-review/reports/t1-artifact-status-audit-inputs.stdout`
  - `.saivage/stages/lesson-cycle-002-bootstrap-recovery-review/reports/t1-artifact-status-audit-lesson001.stdout`

Secret-safety note: this audit did not read hidden `.saivage` config, auth profiles, provider config, env files, OAuth tokens, shell history, `/opt/saivage`, or any service-control state. `/work/diedrico/` was not read directly by this task; only source references already present in lesson artifacts/backlog were inspected as text.

## Executive summary

Cycle 001 correctly preserved lesson 001 as **partial/blocked**, not complete. The prior task report says end-to-end production failed because Diedrico was unreachable at `http://127.0.0.1:5173/` and local TTS/muxing tools were unavailable. The output artifacts are consistent with that status: text/subtitle metadata scaffolding exists, while `recording.mp4` and `narration.wav` are absent and were not fabricated.

However, lesson 001 does **not** satisfy the SPEC §4 produced-lesson contract and must remain excluded from completed catalog entries. Beyond the known external blockers, some present artifacts also do not yet match the final contract shape:

- `plan.md` is non-empty but does not declare the exact required fields `audience`, `learning_goal`, `prereq_lessons`, and `ui_state_setup`.
- `transcript.json` is cue-level JSON, not the required array of `{word, start_s, end_s}` word timings.
- `metadata.json` is a blocked-status metadata note, not the required `{topic, slug, level, duration_s, diedrico_source_refs[], spec_refs[], lesson_hash}` object.
- `subtitles.srt` has valid-looking cues, but the final cue ends at 23 s, and SPEC requires a produced lesson duration of at least 30 s via `recording.mp4`; final subtitle validation cannot pass until video exists.
- `/work/diedrico-lessons/pipeline-status.md` was not present in the inspected output root even though SPEC lists it as the runtime pipeline status file and the current stage expects status accuracy.

## SPEC §4 artifact contract audit

| Artifact | Current state | SPEC §4 status | Notes |
| --- | --- | --- | --- |
| `plan.md` | Present, 1288 bytes | Fails final contract | Non-empty and includes audience/goal/setup concepts, but not the exact required declarations `audience`, `learning_goal`, `prereq_lessons`, `ui_state_setup`. |
| `script.md` | Present, 1037 bytes | Partially satisfies | Broken into four scenes/cues with explicit time targets and visual actions. Total planned duration is 23 s, below the eventual produced-video minimum of 30 s. |
| `recording.mp4` | Missing | Fails final contract | Absence is correctly documented as blocked by unreachable Diedrico and missing muxing tools. |
| `narration.wav` | Missing | Fails final contract | Absence is correctly documented as blocked by missing TTS tooling. |
| `subtitles.srt` | Present, 671 bytes, 4 cues | Partially satisfies | Cue count > 0 and formatting appears SRT-like; final compliance depends on recording duration, which is unavailable. |
| `transcript.json` | Present, 1225 bytes | Fails final contract | Contains `{lessonId,title,cues}` with cue-level timings, not an array of `{word,start_s,end_s}` covering audio. |
| `metadata.json` | Present, 541 bytes | Fails final contract | Contains blocked status, blockers, and TTS strategy, but lacks required `topic`, `level`, `duration_s`, `diedrico_source_refs[]`, `spec_refs[]`, and `lesson_hash`. |
| `implementation-log.md` | Present, 1627 bytes | Suitable as partial log | Clearly records commands, TTS decision, created artifacts, absent media, and retry recommendation. |

## Status artifacts audit

### `catalog.md`

`catalog.md` accurately says no complete lessons have been archived and lists lesson 001 under blocked/partial lessons. It states that plan, script, subtitles, transcript, metadata, and implementation log exist, and that live recording/narration are blocked by Diedrico reachability plus missing local TTS/ffmpeg binaries. This is aligned with the previous task report and avoids overstating completion.

### `backlog.md`

`backlog.md` exists and contains an ordered queue derived from Diedrico source paths. Lesson 001 remains first in the backlog. This is appropriate because lesson 001 is not produced under SPEC §4.

### `pipeline-status.md`

`pipeline-status.md` was not found in the `/work/diedrico-lessons/` root inventory captured by this audit. SPEC lists it as the current state file for the v3 lesson pipeline, and the current stage expects catalog/backlog/status logs to distinguish completed bootstrap scaffolding from externally blocked end-to-end production. This is the main status-artifact gap for the next implementation task.

## Previous task report consistency

The previous task report `t2-bootstrap-lessons-pipeline.json` marked the overall task as failed because required produced-lesson checks could not pass. Its checklist and issues are consistent with the files inspected here:

- Typecheck passed according to `validation/typecheck.stdout`.
- Focused lessons tests passed according to `validation/focused-tests.stdout`.
- Full lint failed only on unrelated unused-variable errors in `src/agents/agent-adapter.ts` and `src/agents/llm-failure-classifiers.ts`, as captured in `validation/lint.stdout`.
- Diedrico probe failed with curl connection refused, as captured in `validation/diedrico-probe.stderr`.
- Tool availability captured no paths for `ffmpeg`, `piper`, `espeak-ng`, or `ffprobe`, as captured in `validation/tool-availability.stdout`.
- `recording.mp4` and `narration.wav` are absent and `validation/artifact-check.stdout` explicitly reports them missing.

## Recommended next actions for coder/data-agent tasks

1. Keep lesson 001 marked partial until every SPEC §4 artifact exists and validates.
2. Create or update `/work/diedrico-lessons/pipeline-status.md` to summarize the blocked state, selected TTS strategy (`piper` when available), missing tools, Diedrico reachability, and next retry criteria.
3. Harden artifact validation to distinguish partial dry-run text artifacts from produced-lesson acceptance. In strict produced-lesson mode, fail on:
   - missing `recording.mp4`/`narration.wav`,
   - plan missing exact required fields,
   - transcript not being word-level timing array,
   - metadata missing required keys,
   - lesson duration below 30 s.
4. If preserving a partial/dry-run mode, make that mode explicit in logs and status so it cannot be mistaken for SPEC §4 production.
5. When Diedrico and tools are available, regenerate lesson 001 end-to-end rather than trying to patch only the catalog status.
