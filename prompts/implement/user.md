<stage_goal>
Implement the approved issue in the working tree with focused code and test changes. GitVibe will commit and push only after your JSON validates and reports completion.
</stage_goal>

<implementation_process>

- Read the issue context, relevant comments, existing files, and nearby tests before editing.
- Treat any `handoffs` in the GitHub context as required prior-stage guidance. Start from the investigation findings and implementation plan unless local code evidence disproves them.
- Before editing, verify current repository standards and validation requirements. Inspect discoverable rule and check sources such as `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING*`, `README*`, relevant docs, `.github/git-vibe.yml` `tests.commands`, package scripts, lint/test/coverage configs, and hook configs like `.husky`, `lint-staged`, `lefthook`, or `.pre-commit-config.yaml` when present.
- Treat configured validation commands from `.github/git-vibe.yml` `tests.commands` as required validation context. If repository standards conflict, required checks cannot be understood, or the issue asks for work that would violate those rules, return `blocked` instead of coding.
- If any configured validation command fails, keep working: investigate the failing test or check and fix it before returning final JSON. Do not dismiss a failing configured check as pre-existing or unrelated while returning `completed`; `completed` requires the configured validation commands you ran to pass.
- If a `review-matrix` handoff reports `changes-required` or findings, address the evidence-backed required fixes first. Skip over-engineering, speculative, obsolete, or out-of-scope review items and explain skipped items in `findings`.
- Make the smallest coherent change that satisfies the approved behavior.
- Reuse existing utilities, conventions, workflows, and test style.
- Add or update tests for changed behavior unless there is a concrete reason not to.
- Run focused checks first, then broader checks when the change scope justifies them.
- Stay scoped to implementing the issue branch. GitVibe's deterministic
  branch-update engine handles validation, commit, and push after your JSON is
  accepted; do not create, update, approve, or merge pull requests from this
  stage.
- Preserve unrelated local changes. Do not revert or reformat unrelated files.
  </implementation_process>

<required_fields_guidance>

- `tests`: Exact commands run and their result. If a command was not run, state the reason.
- `findings`: Important implementation notes, tradeoffs, risks, and repository standards or validation requirements discovered before or while coding.
- `questions`: Maintainer decisions or missing facts that block safe implementation, preferably as answerable question objects with up to four options.
- `branch`: Use the exact deterministic branch from the stage contract.
- `next_state`: Use `changes-ready-for-commit` when completed or `blocked` when no commit should be made.
  </required_fields_guidance>
