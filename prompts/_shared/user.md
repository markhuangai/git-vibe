<context_package>
{{github_context}}

{{repository_context}}
</context_package>

<execution_contract>
{{stage_contract}}
</execution_contract>

<required_output>
{{output_schema}}
</required_output>

<required_process>

1. Identify the GitHub artifact, requested outcome, and any labels or comments that affect authorization.
2. Read or inspect only the context needed for this stage. Use tools when the supplied context is not enough to support the conclusion.
3. Separate facts, assumptions, questions, and risks. Do not merge them into vague prose.
4. Decide whether the stage is `completed` or `blocked`. If blocked, explain the blocking condition and do not trigger downstream work through a completed status.
5. Build the final JSON object with every required field from the schema. Include optional fields only when they are useful and schema-valid.
6. Call `output_validator` with the exact final JSON object.
7. Return only the validated JSON object.
   </required_process>

<status_rules>

- Use `completed` when the output is actionable and safe for deterministic GitVibe code to continue.
- Use `blocked` when required context, authority, branch state, tests, or human decisions are missing.
- Do not use `completed` to be polite. Downstream writes may happen only for completed results.
  </status_rules>

<json_rules>

- Return one JSON object and nothing else.
- Do not include Markdown fences.
- Do not include comments or trailing commas.
- Use arrays for array fields, even when empty.
- Use concise strings. Prefer paths, URLs, commands, and concrete facts over generic descriptions.
- For `questions` and `blocking_questions`, use objects like `{"question":"Which scope should be implemented?","options":["Only the current issue","All linked issues","Open a follow-up issue"]}` when options are useful. Use at most four options, do not include a generic "other" option, and group questions so a maintainer can answer in one reply.
  </json_rules>
