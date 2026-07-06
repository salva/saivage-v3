# Superseded LLM Initial Outcome Design

Status: superseded by [Tool Recovery Design](./tool-recovery-design.md).

Date: 2026-07-06

This document previously described a narrow helper extraction for obtaining the first outcome from a card processor's main LLM. The top-down recovery implementation replaced that helper with the current initial-outcome resolver documented in [Tool Recovery Design §6](./tool-recovery-design.md#6-resolving-the-initial-llm-outcome).

The current design keeps role-specific planner, reviewer, and executor repair loops in their concrete processors. Shared base code owns only LLM lifecycle mechanics, lazy recovery adoption during processor active recovery, and initial outcome resolution for idle, provider-call, and tool-wait states.
