# Development

## Repository Implementation Shape

- `docs/PROJECT_PLAN.md`: project plan index.
- `docs/ARCHITECTURE.md`: architecture, setup, token, and event-delivery details.
- `docs/WORKFLOW.md`: issue, discussion, implementation, feedback, and traceability flows.
- `docs/AI.md`: context assembly, AI stage contracts, provider strategy, and tool policy.
- `.github/git-vibe.example.yml`: starter config for consumer repositories.
- `examples/consumer/.github`: copyable starter config and wrapper workflows for consumer repositories.
- `examples/consumer/.git-vibe`: copyable role-group definitions referenced by the consumer starter config.
- `.github/workflows/investigate.yml`: reusable investigation-only pipeline for bug reports and planning.
- `.github/workflows/validate.yml`: reusable issue or Discussion validation pipeline.
- `.github/workflows/decompose.yml`: reusable validated Discussion decomposition pipeline.
- `.github/workflows/materialize.yml`: reusable Discussion-to-issue materialization pipeline.
- `.github/workflows/develop.yml`: reusable issue development pipeline that implements, creates or updates a PR, then reviews it.
- `.github/workflows/review.yml`: reusable pull request review pipeline.
- `.github/workflows/address-feedback.yml`: reusable PR feedback pipeline that updates the existing PR branch before review when fixes are required.
- `.github/workflows/release.yml`: admin-only manual release workflow that runs from `main`, creates GitHub releases, and promotes the existing GHCR app image to the release tag.
- Reusable GitVibe workflows also support `workflow_dispatch` for source-repo testing. Direct dispatch defaults the action source to the current repository/ref, while `workflow_call` defaults to the pinned `markhuangai/git-vibe@v2` release.
- `.github/workflows/ai-smoke.yml`: manual repo-local smoke test for self-hosted AI runner setup.
- `investigate/`, `implement/`, `review-matrix/`, `create-pr`, `address-pr-feedback/`: public composite action entry points.
- `src/app/server.ts`: self-hosted repository webhook server source.
- `src/runner/actions/run-action.ts`: single-stage runner entry point built by composite actions before execution.
- `src/runner`: config loading, context assembly, prompt rendering, schema validation, stage execution, shared branch-update writes, result publishing, and `ai-sdk-agentool` integration.
- `src/shared`: shared GitHub API helpers, Discussion helpers, labels, stage definitions, traceability helpers, and common types used by both the app and runner.
- `package.json`: single package and lockfile for app, runner, and shared code. Runtime release separation is handled by source boundaries, Docker build output, and workflow path filters rather than package splitting.
- `prompts/`: versioned system and user prompt templates.
- `schemas/stages`: JSON Schema contracts for stage outputs.
- `dist/`: generated build output. It is ignored in git. Docker builds only app/shared output for the app container, while composite actions build the bundled runner action before execution.
- `Dockerfile` and `docker-compose.yml`: self-hosted app deployment packaging.

## Test Plan

- Unit tests for command parsing, config loading, permission checks, label transitions, and hidden metadata markers.
- Unit tests for AI context packet ordering, author weighting, stage contract validation, provider adapter errors, and comment rendering.
- Webhook integration tests for issues, issue comments, discussions, discussion comments, PR conversation comments, PR review comments, source-comment dispatch metadata, and labels.
- End-to-end fixture repo tests for story conversion, implementation issue creation, approved development, PR creation, and PR feedback handling.
- Security tests for guest command rejection, bot-event recursion prevention, fork PR secret protection, token redaction, and non-write stage routing performing no repository mutations.

## Manual AI Smoke Tests

Use the `AI smoke test` workflow in this repository after setting up the
self-hosted runner.

Required AI SDK smoke-test repository secret:

```text
secrets.GITVIBE_AI_ENV_JSON
```

Set bundle keys `GITVIBE_AI_BASE_URL` and `GITVIBE_AI_API_KEY` for the smoke
test. `GITVIBE_AI_BASE_URL` should point to an OpenAI-compatible `/v1` API root.
The local proxy job uses AI SDK plus `agentool`, defaults to `glm-5`, and
requires the model to call the read-only `agentool` file reader.

Codex CLI smoke testing is optional. The workflow installs `@openai/codex`
when the `codex` command is missing, prompts `codex exec`, and validates the
CLI response JSON instead of treating CLI installation as a passed smoke test.
It uses:

```text
secrets.GITVIBE_AI_ENV_JSON
```

Set bundle key `CODEX_AUTH_JSON` to an escaped string containing `auth.json`.
Generate the value with `jq -Rs . < ~/.codex/auth.json`; do not use raw
`jq -c . auth.json` as the bundle value because every `GITVIBE_AI_ENV_JSON`
entry must be a string. Alternatively, pre-seed a persistent
`CODEX_HOME/auth.json` on the runner. When `auth_json.from_bundle` is used,
GitVibe writes refreshed Codex auth back to the repository `GITVIBE_AI_ENV_JSON`
secret after successful CLI execution; the token in `GITVIBE_GITHUB_TOKEN` must
include repository Actions secrets read/write permission for that path.
In GitVibe stages, `cli-codex` runs `codex exec` with
`--dangerously-bypass-approvals-and-sandbox`, `--output-schema`, and
`--output-last-message`; stdout and stderr stream to the action log while the
final message file supplies the structured result for validation.

Claude Code smoke testing is optional. The workflow installs Claude Code through
Anthropic's native installer when the `claude` command is missing, prompts
`claude -p`, and validates the CLI response JSON instead of treating CLI
installation as a passed smoke test. It loads the first enabled
`cli-claude-code` profile from `.github/git-vibe.yml` unless
`GITVIBE_AI_SMOKE_CLAUDE_PROFILE` names a specific profile. `cli-claude-code`
stages run `claude -p` with `--dangerously-skip-permissions`, `--output-format
stream-json`, `--verbose`, and `--json-schema`. GitVibe does not pass stage
`tools` as Claude Code allowed-tool settings; Claude Code owns its native
agent/tool loop while running with skipped permissions. GitVibe also does not
set `--bare` unless a profile explicitly opts in with `bare: true`. Configure
Claude OAuth and provider env through profile `env.<NAME>` mappings using either
`{ from_bundle: KEY }` or literal strings. CLI adapter progress is rendered to
the action log while GitVibe still captures the structured result for
validation.

## Quality Gates

- Lint JavaScript with ESLint flat config.
- Format Markdown, JSON, YAML, and JavaScript with Prettier.
- Build TypeScript app output and bundled actions.
- Run unit tests with Vitest.
- Enforce coverage with Vitest/V8 thresholds: branches 90%, functions 90%, lines 90%, statements 90%.
- Run `github-actionlint` against repository workflows and consumer example workflows.
- Run `pnpm audit --prod` in PR CI.
- Enforce JavaScript/MJS size limits through ESLint: 700 lines per file and 100 lines per function. Generated bundles are excluded.
- Use Husky + lint-staged for staged format/lint checks, then run typecheck and coverage in pre-commit.
- CI is a PR quality gate plus manual dispatch, runs coverage before build, and uses the `docker-runner` self-hosted runner label for this repository.
- Reusable GitVibe workflows install Node `22` and pnpm `10.33.3` before invoking source-built composite actions. The composite actions read `.github/git-vibe.yml` and install Codex CLI or Claude Code only when the selected stage profile uses a matching CLI adapter.

## Assumptions

- The current release is self-host first.
- `markhuangai/git-vibe` is the public action/workflow repository.
- `.github/git-vibe.yml` is the consumer repo config file.
- GitHub-native labels, comments, links, and hidden markers are the source of truth.
- `gvi:` labels are internal runtime labels. Do not add them manually in tests, docs, or examples; issue-level `gvi:review-fix` additionally requires a matching hidden marker with `kind=issue`. PR feedback retries use hidden retry markers but do not add `gvi:review-fix` to the PR.
- Approval uses protected labels, not commands or reactions. Reactions may only be used as an optional community signal to start investigation-only bug review.
- External Codex, Claude, and Copilot integrations are optional GitHub-visible mention partners.
