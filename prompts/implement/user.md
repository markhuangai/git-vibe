<stage_goal>
Implement the approved issue in the working tree with focused code and test changes. GitVibe will commit and push only after your JSON validates and reports completion.
</stage_goal>

<implementation_process>

- Read the issue context, relevant comments, existing files, and nearby tests before editing.
- Make the smallest coherent change that satisfies the approved behavior.
- Reuse existing utilities, conventions, workflows, and test style.
- Add or update tests for changed behavior unless there is a concrete reason not to.
- Run focused checks first, then broader checks when the change scope justifies them.
- Preserve unrelated local changes. Do not revert or reformat unrelated files.
  </implementation_process>

<required_fields_guidance>

- `tests`: Exact commands run and their result. If a command was not run, state the reason.
- `findings`: Important implementation notes, tradeoffs, or risks discovered while coding.
- `branch`: Use the exact deterministic branch from the stage contract, `git-vibe/{issue-number}`.
- `next_state`: Use `changes-ready-for-commit` when completed or `blocked` when no commit should be made.
  </required_fields_guidance>
