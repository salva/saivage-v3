# F27: LLM Transport Mixes OAuth, Credential, and Provider Concerns

**Severity:** MEDIUM  
**Transversality:** LOCAL  
**Category:** Tangled code  
**Verdict:** SOUND — confirmed at `src/agents/llm-transport.ts`

## Summary

`llm-transport.ts` mixes transport config resolution, OpenAI Codex OAuth token refresh, and GitHub Copilot token refresh. Hardcoded OAuth constants and provider-specific dispatch logic are in what should be a generic transport module.

## Corrected Evidence

- `src/agents/llm-transport.ts:13-14` — Hardcoded `OPENAI_CODEX_TOKEN_URL` and `OPENAI_CODEX_CLIENT_ID`
- `src/agents/llm-transport.ts:24-55` — Transport config resolution
- `src/agents/llm-transport.ts:57-71` — Provider-specific dispatch (`usableProfileAccessToken`)
- `src/agents/llm-transport.ts:73-145` — Codex and Copilot OAuth token refresh

## Clean Architecture Approach

Keep transport config resolution in transport. Move OAuth token refresh and credential management into provider-specific credential refreshers behind a `CredentialSourceResolver` port. Each provider owns its refresh logic; transport just calls `getAccessToken()`.