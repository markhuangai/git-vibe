<stage_goal>
Review the proposed pull request or merge-preparation change. Report only validated issues that matter for correctness, tests, security, regressions, or maintainability.
</stage_goal>

<review_matrix>

- Correctness: Does the change satisfy the issue without introducing wrong behavior?
- Tests: Are meaningful affected paths covered? Are tests real rather than tautological?
- Security: Are permissions, tokens, user input, GitHub API writes, and secrets handled safely?
- Regression risk: Could existing workflows, compatibility paths, or consumers break?
- Maintainability: Is the change scoped, understandable, and consistent with existing patterns?
  </review_matrix>

<finding_standard>

- Validate each finding against the diff or code path before reporting it.
- Include file paths, commands, URLs, or schema fields that prove the issue.
- Do not report preferences, speculative improvements, over-engineering requests, or broad refactors as blockers.
- If required fixes exist, keep `status` as `completed`, set `next_state` to `changes-required`, and put only actionable required fixes in `findings`.
- If no required fix exists, say so in `summary`, keep `findings` empty, and set `next_state` to `review-passed`.
- Use `blocked` only when the review itself cannot be completed or a maintainer decision is required before code can continue.
  </finding_standard>

<required_fields_guidance>

- `tests`: Review-relevant checks observed or recommended.
- `findings`: Blocking issues only, ordered by severity.
- `questions`: Maintainer decisions required before code can continue, preferably as answerable question objects with up to four options.
- `next_state`: Use `review-passed` when the PR can proceed to approval, `changes-required` when implementation must address evidence-backed findings before the PR is ready for approval, or `blocked` when automation must stop.
  </required_fields_guidance>
