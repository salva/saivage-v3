# F21 — Design proposals (r1)

Companion to [01-analysis-r1.md](./01-analysis-r1.md). Two proposals ordered by scope.
Project guideline: architecture-first, no backward compatibility, no migration shims, no
new docstrings/comments in untouched code.

## Proposal A — Minimal in-handler resolution

### Intent

Resolve `last` / `current` aliases and default the pivots inside the `cards.diff` handler.
The schema accepts a small union; the handler turns the union into integers using the
current `version_seq`.

### Schema

Replace
[src/contracts/operator-api.ts#L155](../../../../src/contracts/operator-api.ts#L155):

```ts
const diffPivotSchema = z.union([
  z.literal('last'),
  z.literal('current'),
  z.string().regex(/^[1-9][0-9]*$/, 'positive integer or "last"/"current"'),
]);
export const CardDiffQuerySchema = z.object({
  from: diffPivotSchema.optional(),
  to:   diffPivotSchema.optional(),
});
```

Notes:

- Regex `^[1-9][0-9]*$` excludes `0`, leading zeros, signs, decimals — matches the existing
  "positive integer" expectation without a separate `parseInt` check.
- Both pivots become optional. Required-ness is moved to the handler (where defaults are
  applied) so omitted parameters are not a Zod failure.

### Handler

Rewrite [src/server/routes/operator-contracts.ts#L135-L146](../../../../src/server/routes/operator-contracts.ts#L135-L146):

```ts
'cards.diff': ({ params, query }) => {
  const id = (params as unknown as { id: string }).id;
  const q = query as unknown as { from?: string; to?: string };
  const card = store.read(id);
  if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } };

  const resolve = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw === 'last' || raw === 'current') return fallback;
    // Zod has already constrained the shape; parseInt is total here.
    return Number.parseInt(raw, 10);
  };
  const to   = resolve(q.to,   card.version_seq);
  const from = resolve(q.from, Math.max(1, to - 1));

  if (from <= 0 || to <= 0 || from > to) {
    return { statusCode: 400, body: { error: 'Invalid diff pivots', from, to } };
  }
  try { return { body: { diff: redactValue(store.diffCard(id, from, to)), from, to, card_id: id } }; }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      statusCode: message.includes('not found') || message.includes('has no version') ? 404 : 500,
      body: { error: message.includes('not found') || message.includes('has no version') ? 'Card diff source not found' : 'Failed to diff card', message },
    };
  }
},
```

### Response shape

Unchanged: `{ diff, from, to, card_id }` with `from` and `to` as positive integers. The
response schema `CardDiffResponseSchema`
([src/contracts/operator-api.ts#L158](../../../../src/contracts/operator-api.ts#L158))
already constrains them to `z.number().int().positive()`; no edit needed because the
handler always sends the resolved integers.

### Edge cases handled

- New card with `version_seq === 1` and `to=last`: `to=1`, `from=max(1, 0)=1`, so
  `store.diffCard(id, 1, 1)` is called. `diffCard` is defined at
  [src/cards/card-store.ts#L905](../../../../src/cards/card-store.ts#L905); both pivots
  resolve through `getCardAt`, which short-circuits when `versionSeq === current.version_seq`
  ([src/cards/card-store.ts#L897](../../../../src/cards/card-store.ts#L897)). The diff is
  an empty list. We accept that and return 200 with `diff: []`. This is preferable to a
  500 or 400 because "what changed since version 1 on a card with one version" has a
  well-defined answer (nothing).
- `to=last` with `from` numeric and `from > current.version_seq`: handler 400s on
  `from > to`.
- `from=last` is allowed by the schema; the handler resolves it to `card.version_seq`; if
  `to` is omitted, `to` also resolves to `card.version_seq` and the diff is empty. If `to`
  is a smaller integer, `from > to` triggers the 400.

### What this does NOT change

- `store.diffCard` and `store.getCardAt` keep their integer signatures; the alias is a
  pure operator-API concern.
- `src/agents/analyst-tools.ts` `diff_card` tool keeps its own defaulting; it is not
  affected.
- Web client `getCardDiff(id, from, to)` keeps its integer signature; an optional
  default-`to` helper is a small follow-up, deliberately scoped out (see Proposal B).

### Risks

- Two error shapes today: the deleted `"from and to query parameters are required positive
  integers"` and the new `"Invalid diff pivots"`. The existing test in
  [tests/api/cards-history.test.ts#L109-L110](../../../../tests/api/cards-history.test.ts#L109-L110)
  only asserts `status === 400`, not the body — so this is safe.
- Zod failures (e.g. `from=2.5`) now produce the platform's standard validation error
  envelope from `ContractRuntime`, which differs from the handler's `Invalid diff pivots`
  message. Tests that inspect the message must accept either, or assert by category.

## Proposal B — Proposal A + a typed "diff request" abstraction

### Intent

Same wire behaviour as Proposal A, but pulls the resolution into a small reusable shape so
the agent tool, the operator API, and the web client all use one canonical pivot type.

### New module

`src/cards/diff-pivot.ts`:

```ts
export type CardDiffPivot = number | 'last';
export interface CardDiffRequest { id: string; from?: CardDiffPivot; to?: CardDiffPivot }
export function resolveCardDiffPivots(currentVersionSeq: number, req: CardDiffRequest): { from: number; to: number } {
  const to = req.to === undefined || req.to === 'last' ? currentVersionSeq : req.to;
  const from = req.from === undefined || req.from === 'last' ? Math.max(1, to - 1) : req.from;
  return { from, to };
}
```

Note: only `'last'` is exposed in the typed surface. `'current'` remains an HTTP-only
alias accepted by the schema for ergonomic parity; the schema layer normalises it to
`'last'` before calling the resolver. No `CardDiffPivot` consumer outside the schema sees
`'current'`.

### Wiring

- `src/contracts/operator-api.ts` — same schema change as Proposal A; in addition, after
  parsing, normalise `'current'` → `'last'` on the way into the handler (handler signature
  becomes simpler).
- `src/server/routes/operator-contracts.ts` — handler delegates to
  `resolveCardDiffPivots(card.version_seq, { id, from, to })`.
- `src/agents/analyst-tools.ts` — replace inline `params.toSeq ?? card.version_seq` /
  `Math.max(1, toSeq - 1)` at
  [src/agents/analyst-tools.ts#L136](../../../../src/agents/analyst-tools.ts#L136) with a
  call to `resolveCardDiffPivots`. The tool's input schema
  ([src/tools/agent-tools.ts#L103](../../../../src/tools/agent-tools.ts#L103)) widens
  `fromSeq` / `toSeq` to `z.union([z.number().int(), z.literal('last')]).optional()`.
- `web/src/api/client.ts` — `getCardDiff(id, from?, to?)` accepts `number | 'last'` and
  passes the value as-is in the query string.

### Trade-off vs Proposal A

Pro: one source of truth for the pivot semantics; the agent tool and the HTTP route stop
duplicating the "default to current, default from to to-1" rule. Closes a tiny but real
drift surface.

Con: 3 extra files touched and a contract change to the agent tool input schema. The
agent tool input schema change has no observable risk (callers pass either numbers or
omit the field today), but it widens the contract beyond F21's stated scope.

## Recommendation

**Proposal A** for r1. It is the smallest patch consistent with the architecture-first
guideline (no dead abstractions for a one-call-site rule), and it deletes the obsolete
`parseInt`-based 400 branch rather than layering on top of it. If the reviewer wants the
agent tool to share the helper, escalate to Proposal B in r2; otherwise A is sufficient.
