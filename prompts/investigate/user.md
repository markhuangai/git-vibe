<stage_goal>
Investigate the reported bug and produce a triage-quality result. The result should help a maintainer decide whether the issue needs more information, can move to validation, or is ready for implementation.
</stage_goal>

<investigation_focus>

- Restate the reported behavior and expected behavior only when supported by the issue or comments.
- Before planning implementation, discover repository standards and validation requirements that a later coding agent must follow. Inspect discoverable rule and check sources such as `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING*`, `README*`, relevant docs, `.github/git-vibe.yml` `tests.commands`, package scripts, lint/test/coverage configs, and hook configs like `.husky`, `lint-staged`, `lefthook`, or `.pre-commit-config.yaml` when present.
- Identify reproduction steps, environment details, affected commands, workflows, or files when present.
- Inspect likely code paths or tests if the report names them or if repository context makes them discoverable.
- If the issue is a GitVibe review-fix issue, treat it as continuation work on the linked root issue. First check the repository context for the root branch name, whether GitVibe found the remote branch, and the current branch state, then focus the plan on the required review fixes.
- Call out contradictions, missing expected behavior, missing reproduction data, or claims that could not be verified.
- Put maintainer decisions or missing facts that would materially change implementation in `blocking_questions`; do not hide blockers in `questions`.
- Resolve discoverable technical unknowns during investigation. If a required technical detail cannot be verified before coding, put it in `blocking_questions` and do not mark the issue ready for implementation.
- Do not propose a patch unless the evidence clearly supports the likely fix area; even then, describe it as direction, not implementation.
  </investigation_focus>

<required_fields_guidance>

- `findings`: Evidence-backed observations, each with a path, URL, command, or artifact reference when possible. Include discovered repository coding standards, pre-commit or hook requirements, validation commands, and coverage or lint constraints that affect implementation.
- `blocking_questions`: Specific maintainer decisions or missing facts that must be answered before implementation can start.
- `questions`: Non-blocking uncertainties or follow-up details that do not materially change the implementation plan.
- `implementation_plan`: When the issue is ready for implementation, list concrete implementation steps for the next agent. Include the applicable repository standards and validation checks the implementer must honor or run, then name target files, functions, tests, workflow files, or schemas when evidence supports them. Do not include speculative code. Leave this empty when blocking questions remain.
- `comment_body`: Summarize the repo rules and required checks that matter for the implementation so they are visible in the issue comment and handoff.
- `proposed_labels`: Useful triage labels only when justified by the evidence.
- `next_state`: Use `needs-info`, `ready-for-validation`, `ready-for-implementation`, or `blocked`.
  </required_fields_guidance>
