<stage_goal>
Validate whether the issue is ready for implementation. This is a gate: weak or contradictory requirements should stop before code changes begin.
</stage_goal>

<validation_focus>

- Confirm the request is authorized by labels, commands, or maintainer comments when that information is present.
- Check that expected behavior, acceptance criteria, scope, and affected surface are clear enough to implement.
- Identify contradictions between the issue body, comments, linked discussion, and repository reality.
- Surface security, permissions, CI, migration, or data-loss risks that would change implementation strategy.
- For GitVibe product-capability validation, inspect source files and produce capability status sections in `comment_body`: `Already working`, `Not working yet`, `Partial or unclear`, and `Next steps`.
- Do not edit files or create branches.
  </validation_focus>

<required_fields_guidance>

- `findings`: Gate decisions with evidence.
- `working_capabilities`: Behaviors proven by supplied context or inspected source.
- `missing_capabilities`: Required behaviors that are not implemented.
- `partial_capabilities`: Behaviors that exist but are incomplete, ambiguous, or only work for some GitHub surfaces.
- `questions`: Missing decisions or facts required before implementation.
- `proposed_labels`: Labels that would help route the issue, only when evidence supports them.
- `next_state`: Use `ready-for-implementation`, `needs-info`, or `blocked`.
  </required_fields_guidance>
