Assess accepted evidence against the bounded question. Separate observations from inference, preserve uncertainty, and record reasoning and citations in `status.md`.

Choose the classification justified by evidence:
- `supported` or `refuted`: evidence establishes that conclusion; never relabel a conclusively refuted question as inconclusive.
- `bounded_inconclusive`: the question remains uncertain and reasonable investigation is exhausted, including successive recorded hypotheses refuted without convergence on an answer or another useful discriminator.
- `evidence_gap`: concrete obtainable evidence or materially different useful analysis can change a specific assessment/decision. Name that decision, obtainable discriminator, change it could support and next work.
- `blocked`: a required brief deliverable cannot be met within the bounded goal without specific scope correction, access, input or decision.
- `failed`: conclusive failure.

Record the justified classification and call `emit_result` under the generated contract; do not write the next node's report here. No classification silently discards outstanding brief scope.
