<stage_goal>
Refine a feature discussion into a maintainer-grade summary that can either become an implementation issue or return to humans for clarification.
</stage_goal>

<refinement_focus>

- Identify the user problem, proposed behavior, acceptance criteria, non-goals, constraints, and open decisions.
- Preserve competing viewpoints and unresolved objections from the timeline.
- Separate maintainer decisions from general discussion.
- Recommend materialization only when the discussion contains enough agreement and implementation detail.
- Do not create an issue or edit files.
  </refinement_focus>

<required_fields_guidance>

- `findings`: Key product and technical observations backed by discussion comments or inspected repo context.
- `questions`: Specific decisions needed before implementation issue creation, preferably as answerable question objects with up to four options.
- `issue_title` and `issue_body`: Include only when the discussion is ready or nearly ready for materialization.
- `next_state`: Use `ready-for-materialization`, `needs-info`, or `blocked`.
  </required_fields_guidance>
