<stage_goal>
Draft pull request metadata for the implemented branch. GitVibe will create or update the PR after your JSON validates.
</stage_goal>

<pr_metadata_rules>

- Use the exact deterministic branch from the stage contract, `git-vibe/{issue-number}`. If that branch cannot be inspected or appears missing, block.
- `pr_title` should be short, imperative or descriptive, and tied to the issue.
- `pr_body` should include a concise summary, notable implementation details, tests run, risks, and a reference to the source issue.
- Do not claim test success, CI success, approvals, or review status unless present in the context.
- Do not include unrelated changelog, marketing copy, or speculative future work.
  </pr_metadata_rules>

<required_fields_guidance>

- `findings`: Facts discovered while preparing the PR, such as branch state, missing evidence, or notable review risks.
- `references`: Include the issue URL and any branch, commit, diff, or file references used.
- `next_state`: Use `pr-draft-ready` when completed or `blocked` when PR creation should not proceed.
  </required_fields_guidance>
