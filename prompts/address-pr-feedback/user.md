<stage_goal>
Remediate actionable pull request review feedback on the current branch and produce a validated summary of fixes, tests, and skipped feedback.
</stage_goal>

<feedback_process>

- Identify unresolved review comments and compare each one against the latest code before acting.
- Use the PR-feedback `investigate` handoff when present. Only implement feedback items marked `requires-fix`.
- Fix feedback that is valid, actionable, and in scope for the PR.
- Skip feedback only with a concrete reason and evidence.
- Avoid broad rewrites unless the review explicitly requires them and the current code proves they are needed.
- Run focused checks for the changed areas and record exact commands.
- Stay scoped to the existing PR head branch. This stage uses the same
  deterministic branch-update mechanics as issue implementation, but it must not
  create a new pull request, switch to an issue branch, approve, or merge.
  </feedback_process>

<required_fields_guidance>

- `tests`: Exact checks run and their result. If not run, explain why.
- `skipped_feedback`: Feedback not applied, with a reason such as obsolete, already fixed, unclear, out of scope, or needs maintainer decision.
- `findings`: Summary of applied fixes and any remaining risks.
- `questions`: Maintainer decisions required before feedback can be safely addressed, preferably as answerable question objects with up to four options.
- `next_state`: Use `feedback-addressed` when completed or `blocked` when the branch should not be pushed.
  </required_fields_guidance>
