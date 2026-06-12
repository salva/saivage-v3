# F09 — Tactical `model_repair` nudge loop is a band-aid in the wrong layer

## Summary

Commit `a2a6f05` introduced an in-line mitigation in `AgentAdapter.invokeAgent`:
when the model replies with a plain message during a tool-bearing turn, the
adapter persists the assistant text, appends a `system`/`model_repair` row
with a hand-written nudge string, and continues the loop. This kept the
operator's trigger case from killing the candidate, but it now lives in the
hottest function in the runtime, encodes the repair vocabulary as an inline
template literal, and shares no code with the post-loop
`terminal_tool_missing` path that still throws on exhaustion (see F02 and F08).

## Evidence

- [agent-adapter.ts#L305](src/agents/agent-adapter.ts#L305) — the entire
  mitigation lives inline:

  ```ts
  if (result.kind === 'message') {
    if (!expectsEnvelope) { finalEnvelope = { content: result.content }; break; }
    if (result.content && result.content.length > 0) {
      this.appendSessionMessage(session.id, { role: 'assistant', kind: 'text', content: result.content });
    }
    const remaining = maxToolTurns - turn - 1;
    const nudge = remaining > 0
      ? `Your previous reply was a plain message, but this turn expects tool calls. ...`
      : `Your previous reply was a plain message and this is the last turn. ...`;
    this.appendSessionMessage(session.id, { role: 'system', kind: 'model_repair', content: nudge });
    continue;
  }
  ```

- The corresponding `model_repair` MessageKind exists already in
  `schemas/types.ts`, but only this one site emits it; no contract layer
  consumes it.

- Commit message confirms the intent: "tactical mitigation; the broader
  contract-verifier redesign tracked in
  SPEC/v0.2/review-2026-05-agent-autonomy/ may supersede it".

## Category

over-featurism

## Severity

medium

## Transversality

local

## Why this matters for the redesign

The mitigation already does, badly, what the new design should do well:
detect a contract miss, write a structured repair message, continue. The
redesign should subsume it — same idea, but driven by the verifier (structured
unmet-obligation diff, contract-defined repair vocabulary, single termination
predicate) rather than by an ad-hoc string template inside the per-turn loop.
After the redesign, this inline branch should disappear entirely.
