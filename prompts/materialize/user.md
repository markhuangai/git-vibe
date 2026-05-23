<stage_goal>
Create precise implementation issue drafts from an accepted feature discussion. GitVibe will publish the issues after your JSON validates.
</stage_goal>

<issue_drafting_rules>

- Each `issues[]` item should be specific, action-oriented, and scoped to one implementation unit.
- Return exactly one `issues[]` item for `/git-vibe materialize` or label-triggered materialization unless the discussion or source command explicitly asks for multiple implementation issues.
- If the source comment asks for a split, such as `/git-vibe materialize split the story into 5 issues since it is too big`, decompose the accepted scope inside materialization and return that many coherent issue drafts unless doing so would be unsafe or arbitrary.
- Each issue should include background, requirements, acceptance criteria, backpressure commands, dependency metadata, parallel group, and review guidelines.
- Use `blocked_by` to name issue titles that must complete first. Use an empty array only when there is no dependency.
- Use `parallel_group` to group issues that can be worked in parallel after dependencies are satisfied. Use stable, short strings such as `foundation`, `api`, `ui`, or `docs-tests`.
- Include open questions only when they do not block implementation. If they do block implementation, return `blocked`.
- Do not add requirements that were not present or reasonably implied by accepted discussion.
- Do not create issues yourself.
  </issue_drafting_rules>

<required_fields_guidance>

- `findings`: Acceptance evidence, scope constraints, and any discussion risks.
- `questions`: Non-blocking open decisions, preferably as answerable question objects with up to four options. If the questions block a safe issue draft, return `blocked`.
- `references`: Include the source discussion URL and key comment URLs when available.
- `issues`: One or more implementation issues to create. Each item must include `title`, `background`, `requirements`, `acceptance_criteria`, `backpressure_commands`, `blocked_by`, `parallel_group`, and `review_guidelines`.
- `next_state`: Use `implementation-issues-ready` when completed or `blocked` when issues should not be created.
  </required_fields_guidance>
