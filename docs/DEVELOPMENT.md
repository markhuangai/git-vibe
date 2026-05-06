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
- `src/runner/actions/run-action.ts`: runner entry point built by composite actions before execution.
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
- Webhook integration tests for issues, issue comments, discussions, discussion comments, PR comments, review comments, and labels.
- End-to-end fixture repo tests for story conversion, implementation issue creation, approved development, PR creation, and PR feedback handling.
- Security tests for guest command rejection, bot-event recursion prevention, fork PR secret protection, token redaction, and read-only AI stages performing no mutations.

## Manual AI Smoke Tests

Use the `AI smoke test` workflow in this repository after setting up the
self-hosted runner.

Required local proxy repository variables and secrets:

```text
vars.GITVIBE_AI_BASE_URL
vars.GITVIBE_AI_MODEL
secrets.GITVIBE_AI_API_KEY
```

`GITVIBE_AI_BASE_URL` should point to an OpenAI-compatible `/v1` API root. The
local proxy job uses AI SDK plus `agentool` and, by default, requires the model to
call the read-only `agentool` file reader.

Codex CLI smoke testing is optional. The workflow installs `@openai/codex`
when the `codex` command is missing, then uses:

```text
secrets.CODEX_AUTH_JSON
```

Or pre-seed a persistent `CODEX_HOME/auth.json` on the runner. GitVibe only seeds
the file when it is missing, so Codex can refresh it between runs.

Claude Code smoke testing is optional. The workflow installs Claude Code through
Anthropic's native installer when the `claude` command is missing, then verifies
`claude --version`. Authentication is separate from the install smoke test.

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
- CI is a PR quality gate plus manual dispatch, runs coverage before build, and must run on `self-hosted` runners for this repository.
- Reusable GitVibe workflows install Node `22` and pnpm `10.33.3` before invoking source-built composite actions. Do not rely on global runner `pnpm` or Corepack for stage execution.

## Assumptions

- v1 is self-host first.
- `git-vibe/actions` is the public action/workflow repository.
- `.github/git-vibe.yml` is the consumer repo config file.
- GitHub-native labels, comments, links, and hidden markers are the source of truth.
- Approval uses commands plus labels, not reactions. Reactions may only be used as an optional community signal to start investigation-only bug review.
- External Codex, Claude, and Copilot integrations are optional GitHub-visible mention partners.
