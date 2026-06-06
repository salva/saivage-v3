# F20: Two Pause/Resume Paths (Offline Control vs Live Runtime)

**Severity:** MEDIUM  
**Transversality:** LOCAL  
**Category:** Duplication of concerns  
**Verdict:** PARTLY SOUND — paths share patch construction but differ significantly in side effects

## Summary

`src/runtime/control.ts` handles pause/resume for offline/operator API calls, while `src/runtime/runtime-pause-resume.ts` handles pause/resume for the live runtime. The offline path patches persisted state directly; the live path additionally updates lifecycle flags, process buffering, event logging, planner resume context, queued planner notes, and requests an immediate tick.

## Corrected Evidence

- `src/runtime/control.ts:40-149` — Offline pause/resume that patches persisted state; delegates to live runtime API when available (lines 62-64, 117-120)
- `src/runtime/runtime-pause-resume.ts:25-64` — Live pause/resume with additional lifecycle/effects

Overstatement corrected: the two paths are not "nearly identical." The live path adds lifecycle flags, process buffering, planner resume context, notifications, and tick requests. The offline path delegates to the live path when runtime is available. Also, `FROZEN_RUNTIME_RECOVERY_MESSAGE` is not duplicated — it is exported from `control.ts` and re-exported by `control-api.ts`.

## Clean Architecture Approach

Create one runtime-control command handler that computes the state patch (`buildPauseRuntimeStatePatch`/`buildResumeRuntimeStatePatch`) and accepts effect ports for live-only side effects: lifecycle flags, process buffering, event emission, planner resume context, notifications, and tick. CLI/API calls this handler with a minimal effect set; live runtime calls it with the full effect set. Remove the separate `control.ts` patch-and-write path.