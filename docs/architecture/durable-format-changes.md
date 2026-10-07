# Durable format changes

This maintained list records evidenced changes requiring incompatible adoption.
It is a subordinate inventory, not runtime metadata, a compatibility checker, a
converter, or operational consent. Current contracts remain owned by the
[specification](../spec/system-specification.md) and
[architecture](./system-architecture.md); procedures remain owned by the
[runbook](../runbook/index.md#external-migrations).

## Conversation image results — 2026-10-07, conversation format 4→5

Introducing source commit:
`c527da662ef3d2c6db616983643bfbe7aeab1055` (`feat(agents): support immutable image inspection`).
The producer-neutral result follow-up belongs to this **same undeployed cutover**,
not a format-6 change. No installed instance was deployed or migrated by this
source issue; source completion/push is not deployment, reset or migration permission.

Exact discriminators advance together from **4 to 5**:

- Conversation index `format_version`.
- Ordinary and compacted conversation genesis `format_version`.
- Conversation-segment envelope `version`.

These discriminators are defined together in
`src/persistence/canonical-conversation-artifacts.ts`
(`conversationVersionIndexSchema`, shared `genesisBase`, and
`conversationSegmentEnvelopeSchema`), not inferred from PNG files or release names.

Unrelated card, record and provider-evidence versions do not change. Selected image
bodies are ordinary PNG files, not a separate versioned catalog.

The durable successful result may explicitly select one strict image descriptor
`{id,mime_type:'image/png',width,height,byte_length,sha256}` only with an executed
settlement and matching canonical call/result, policy, evidence and hash commitments.
Pixels live in the exact owning session's `images/<UUID>.png`, outside JSONL.
Consumption validates selected bytes/hash/dimensions; metadata inspection does not
inventory binary bodies. Unselected artifacts remain ignored forever.

`view_image` is the only implemented authorized producer. Its workspace metadata
is strict at production and canonical consumption, including sent-dimension
consistency. The lower typed result/constructor is producer-neutral: a future
explicitly implemented producer could supply its own data without pretending to be
`view_image`. This installs no MCP image ingress; arbitrary nested `data.image`,
`image_url` or base64 objects remain ordinary data, never attachments.

### Adoption and limits

Earlier-format and mixed state is rejected by strict current consumers. Equal
outer versions alone do not prove release compatibility. Adoption requires a
matching release and separately authorized operational actions:

- A separately consented whole-generated-state reset loses generated history.
- An explicitly owner-requested external offline migration follows the runbook's
  stopped/excluded, successful fresh complete preserved backup, independent
  complete candidate and strict full-validation gates, outside Saivage core.
  Never fabricate prior images/provenance or ship format converters.

This is the **initial evidenced entry only**, not an exhaustive historical catalog.
Absent entries do not establish compatibility. The entry records durable format
meaning and source status; it certifies no installed state, migration fidelity,
provider perception, or lossless recovery.
