<stage_goal>
Create a precise implementation issue draft from an accepted feature discussion. GitVibe will publish the issue after your JSON validates.
</stage_goal>

<issue_drafting_rules>

- `issue_title` should be specific, action-oriented, and scoped to one implementation unit.
- `issue_body` should include context, desired behavior, acceptance criteria, non-goals, risks, and source discussion links.
- Include open questions only when they do not block implementation. If they do block implementation, return `blocked`.
- Do not add requirements that were not present or reasonably implied by accepted discussion.
- Do not create the issue yourself.
  </issue_drafting_rules>

<required_fields_guidance>

- `findings`: Acceptance evidence, scope constraints, and any discussion risks.
- `questions`: Non-blocking open decisions, preferably as answerable question objects with up to four options. If the questions block a safe issue draft, return `blocked`.
- `references`: Include the source discussion URL and key comment URLs when available.
- `next_state`: Use `implementation-issue-ready` when completed or `blocked` when the issue should not be created.
  </required_fields_guidance>
