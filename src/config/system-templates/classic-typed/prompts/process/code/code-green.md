Repair the accepted reproduced gap at its owning primitive, with needed affected-path regression coverage. The smallest coherent repair is the complete scoped fix, not the smallest textual diff or a symptom workaround. Run the focused reproducer; record diagnosis, changed files, commands, results and relevant attempted hypotheses in `status.md`.

Choose the result from evidence:
- `green`: the reproducer passes.
- `still_red`: materially changed diagnosis or implementation evidence supports a concrete useful next attempt.
- `blocked`: a specifically identified required input, access or decision is genuinely unavailable, not merely uncertain or difficult engineering.
- `failed`: either evidence establishes the task cannot succeed within accepted constraints, or materially distinct reasonable attempts remain unsatisfied, their named hypotheses and observed failures are recorded, diagnosis/implementation is not converging and no justified useful next attempt remains. Record exhausted hypotheses, residual uncertainty and remaining work without claiming global impossibility.
