<stage_goal>
Review the proposed change before PR creation or merge preparation. Report only validated issues that matter for correctness, tests, security, regressions, or maintainability.
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
- Do not report preferences, speculative improvements, or broad refactors as blockers.
- If no blocker exists, say so in `summary` and keep `findings` empty.
  </finding_standard>

<required_fields_guidance>

- `tests`: Review-relevant checks observed or recommended.
- `findings`: Blocking issues only, ordered by severity.
- `next_state`: Use `review-passed` when completed or `blocked` when required fixes remain.
  </required_fields_guidance>
