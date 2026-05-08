<stage_goal>
Investigate the reported bug and produce a triage-quality result. The result should help a maintainer decide whether the issue needs more information, can move to validation, or is ready for implementation.
</stage_goal>

<investigation_focus>

- Restate the reported behavior and expected behavior only when supported by the issue or comments.
- Identify reproduction steps, environment details, affected commands, workflows, or files when present.
- Inspect likely code paths or tests if the report names them or if repository context makes them discoverable.
- If the issue is a GitVibe review-fix issue, treat it as continuation work on the linked root issue. First check the repository context for the root branch name, whether GitVibe found the remote branch, and the current branch state, then focus the plan on the required review fixes.
- Call out contradictions, missing expected behavior, missing reproduction data, or claims that could not be verified.
- Do not propose a patch unless the evidence clearly supports the likely fix area; even then, describe it as direction, not implementation.
  </investigation_focus>

<required_fields_guidance>

- `findings`: Evidence-backed observations, each with a path, URL, command, or artifact reference when possible.
- `questions`: Specific missing information needed from the reporter or maintainer.
- `implementation_plan`: When the issue is ready for implementation, list concrete implementation steps for the next agent. Name target files, functions, tests, workflow files, or schemas when evidence supports them. Do not include speculative code.
- `proposed_labels`: Useful triage labels only when justified by the evidence.
- `next_state`: Use `needs-info`, `ready-for-validation`, `ready-for-implementation`, or `blocked`.
  </required_fields_guidance>
