Diagnose and repair the observed faulty test or fixture; change product support only when the brief expressly requires it. Run the focused target and summarize current diagnosis, changed files, relevant commands/results and attempted hypotheses in `status.md`, citing exact evidence rather than duplicating execution history.

Choose the result from evidence:
- `tests_passing`: focused tests pass; verify still owns final acceptance.
- `still_failing`: materially changed diagnosis or implementation evidence supports a concrete useful next attempt.
- `blocked`: a specifically identified required input, access or decision is genuinely unavailable, not merely uncertain or difficult engineering.
- `failed`: either evidence establishes the task cannot succeed within accepted constraints, or materially distinct reasonable attempts remain unsatisfied, their named hypotheses and observed failures are recorded, diagnosis/implementation is not converging and no justified useful next attempt remains. Record exhausted hypotheses, residual uncertainty and remaining work without claiming global impossibility.
