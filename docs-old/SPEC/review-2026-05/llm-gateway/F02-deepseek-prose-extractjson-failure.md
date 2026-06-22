# F02 — `extractJson` cannot recover prose answers from `deepseek-v4-pro`

## Summary

When `nvidia-nim/deepseek-v4-pro` is asked with both `response_format=json_object` AND `tools[]` (see F01), it accepts the request, answers with free-form prose, and the runtime then throws `ResultParseError("Could not extract valid JSON from response")` because `extractJson` has only three layered fallbacks (code-fence-first, raw-parse, brace-span slice) — none of them handle prose-with-no-JSON-block.

## Evidence

The extractor:
- [src/agents/result-parser.ts#L257-L271](src/agents/result-parser.ts#L257)
```ts
export function extractJson(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]) as Record<string, unknown>;
  try { return JSON.parse(raw.trim()) as Record<string, unknown>; } catch { /* fall through */ }
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = raw.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(slice) as Record<string, unknown>; } catch { /* fall through */ }
  }
  throw new ResultParseError('Could not extract valid JSON from response', raw, []);
}
```

Production error message verbatim matches the throw site.

Classifier path:
- [src/agents/invocation-recovery-policy.ts#L99-L116](src/agents/invocation-recovery-policy.ts#L99) — `ResultParseError instanceof LlmParseError` (declared in `result-parser.ts` to extend `LlmParseError`) → classified as `parse_or_contract` → action `failover_without_cooldown`. So failover happens but health is not poisoned. The chain still exhausts when several prose-answering providers are stacked.

Causal chain: F01 sends an option pair that `deepseek-v4-pro` does not refuse explicitly but cannot honour. Without F01, `deepseek-v4-pro` would either be skipped (with proper capabilities) or would receive a tools-only request, both of which it handles correctly per operator history.

## Category

new

## Severity

high — primary user-visible failure mode for nvidia-nim DeepSeek roles; degrades the entire chain when DeepSeek is the first non-rate-limited candidate.

## Transversality

scoped to the result-parser, but the root cause is in the option assembler (F01). Fixing F01 fixes the trigger; hardening `extractJson` reduces blast radius for future prose-tendencies of other providers.

## Recommended direction

- Fix F01 first (eliminate the trigger).
- Add a "rescue" step that scans for the canonical envelope keys (`thought`, `actions`, etc.) and reports them explicitly when missing, replacing the generic "Could not extract valid JSON" with a structured `ResultParseError` carrying the first 200 characters of the response and the missing required keys. This is purely diagnostic but turns a recurring on-call mystery into a one-glance event.
- Consider promoting the envelope schema to a Zod parser per role so the failure includes the schema diff, not just `partial: raw`.

## Cross-links

- F01 — trigger.
- F05 — architectural: tool calls and JSON envelopes should not coexist as response carriers.
- F09 — `extractJson` brace-span fallback is brittle for partially-JSON responses.
