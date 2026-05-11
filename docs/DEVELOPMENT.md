# Development

## Repository Implementation Shape

- `docs/PROJECT_PLAN.md`: project plan index.
- `docs/ARCHITECTURE.md`: architecture, setup, token, and event-delivery details.
- `docs/WORKFLOW.md`: issue, discussion, implementation, feedback, and traceability flows.
- `docs/AI.md`: context assembly, AI stage contracts, provider strategy, and tool policy.
- `.github/git-vibe.example.yml`: starter config for consumer repositories.
- `examples/consumer/.github`: copyable starter config and wrapper workflows for consumer repositories.
- `.github/workflows/investigate.yml`: reusable investigation-only pipeline for bug reports and planning.
- `.github/workflows/develop.yml`: reusable end-to-end development pipeline.
- `.github/workflows/address-feedback.yml`: reusable PR feedback pipeline.
- Reusable GitVibe workflows also support `workflow_dispatch` for source-repo testing. Direct dispatch defaults the action source to the current repository/ref, while `workflow_call` defaults to `git-vibe/actions@main` until a release tag exists.
- `.github/workflows/ai-smoke.yml`: manual repo-local smoke test for self-hosted AI runner setup.
- `investigate/`, `implement/`, `review-matrix/`, `create-pr`, `address-pr-feedback/`: public composite action entry points.
- `src/app/server.ts`: self-hosted repository webhook server source.
- `src/runner/actions/run-action.ts`: single-stage runner entry point built by composite actions before execution.
- `src/runner`: config loading, context assembly, prompt rendering, schema validation, stage execution, result publishing, and `ai-sdk-agentool` integration.
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
when the `codex` command is missing, then uses:

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
Anthropic's native installer when the `claude` command is missing, then verifies
`claude --version`. `cli-claude-code` stages run `claude -p` with
`--dangerously-skip-permissions`, `--output-format json`, and `--json-schema`;
profile `bare: true` adds Claude Code's minimal mode for API-key or third-party
provider auth. Configure Claude OAuth and provider env through profile
`env.<NAME>.from_bundle` mappings. CLI adapter stdout and stderr are streamed to
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

- v1 is self-host first.
- `git-vibe/actions` is the public action/workflow repository.
- `.github/git-vibe.yml` is the consumer repo config file.
- GitHub-native labels, comments, links, and hidden markers are the source of truth.
- `gvi:` labels are internal runtime labels. Do not add them manually in tests, docs, or examples unless the flow also creates the matching hidden marker.
- Approval uses protected labels, not commands or reactions. Reactions may only be used as an optional community signal to start investigation-only bug review.
- External Codex, Claude, and Copilot integrations are optional GitHub-visible mention partners.
