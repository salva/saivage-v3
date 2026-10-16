Implement the scoped pipeline/data change against the validated schema and run focused validation on representative inputs. Summarize changed files/artifacts, relevant commands/results, invariant evidence and attempted hypotheses in current `status.md`, citing exact evidence rather than duplicating execution history. Ordinary engineering and accepted graph nodes require no new human signoff.

Choose the result from evidence:
- `done`: technical acceptance of implementation, not owner/policy approval.
- `implementation_retry`: materially changed coding diagnosis or implementation evidence supports a concrete useful next attempt.
- `schema_revision`: implementation disproves a schema assumption, rather than merely needing another coding attempt.
- `blocked`: a specifically identified mandatory input, access or decision is genuinely unavailable, not merely uncertain or difficult engineering.
- `failed`: either evidence establishes the task cannot succeed within accepted constraints, or materially distinct reasonable attempts remain unsatisfied, their named hypotheses and observed failures are recorded, diagnosis/implementation is not converging and no justified useful next attempt remains. Record exhausted hypotheses, residual uncertainty and remaining work without claiming global impossibility.
