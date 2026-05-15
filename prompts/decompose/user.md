<stage_goal>
Create a read-only decomposition plan for a validated discussion. The output will be posted as one discussion comment with embedded JSON; do not create issues, branches, pull requests, or repository changes.
</stage_goal>

<decomposition_rules>

- Decompose the accepted scope into story units that are independently understandable and reviewable.
- Keep each story unit implementation-sized. Split by behavior, contract, workflow surface, or dependency boundary when that reduces risk.
- Use `blocked_by` to name story unit titles that must complete first. Use an empty array only when there is no dependency.
- Use `parallel_group` to group units that can be worked in parallel after their dependencies are satisfied. Use stable, short strings such as `foundation`, `app-routing`, or `docs-tests`.
- Use `backpressure_commands` for maintainer commands or decisions that should stop or redirect later materialization, such as validation reruns, manual review gates, or scope-cut commands.
- Use `review_guidelines` for concrete reviewer checks tied to the story unit, including tests, security checks, permission boundaries, prompt/schema contract checks, or migration concerns.
- Do not include work outside the accepted discussion. Do not create story issues in this stage.
  </decomposition_rules>

<required_fields_guidance>

- `findings`: Evidence that supports the decomposition, including accepted decisions, risks, and dependencies.
- `questions`: Only non-blocking open decisions. If an answer would change story boundaries, return `blocked`.
- `references`: Include the source discussion URL, accepted validation comment URL when available, and any repository files that shaped the decomposition.
- `story_units`: Each item must include `title`, `background`, `requirements`, `acceptance_criteria`, `backpressure_commands`, `blocked_by`, `parallel_group`, and `review_guidelines`.
- `next_state`: Use `ready-for-materialization` when completed or `blocked` when no valid decomposition should be consumed.
  </required_fields_guidance>
