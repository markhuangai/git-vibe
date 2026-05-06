# GitVibe

GitVibe is an experimental workflow for using GitHub issues, discussions, labels, pull requests, and reusable Actions as an AI-assisted development pipeline.

The intended public action repository is `git-vibe/actions`.

## Shape

- A self-hosted repository webhook server receives events, validates repo permissions, updates GitHub-native state, and dispatches workflows.
- Reusable GitHub Actions execute the pipeline stages on GitHub-hosted or self-hosted runners.
- GitHub remains the source of truth through labels, comments, links, and pull requests.

The TypeScript source is split by runtime boundary while staying in one package:

- `src/app`: self-hosted webhook server code that ships in the Docker image.
- `src/runner`: GitHub Action runner code, AI stage execution, prompts, schemas, and deterministic runner writes.
- `src/shared`: shared GitHub helpers, labels, stage definitions, traceability helpers, and common types used by both runtimes.

The Docker app image builds only app/shared output. Runner-only source, prompts, and schemas are built by composite actions on the runner and do not trigger app deployment unless shared/package/deploy files change.

## Consumer Repo Quick Start

In the repository that should use GitVibe:

1. Configure a repository webhook that points to the self-hosted GitVibe server.
2. Copy the starter files from this repository:

   ```bash
   cp -R examples/consumer/.github /path/to/your-repo/.github
   ```

3. Edit `.github/git-vibe.yml` for the target repo.
4. Add the required repository or organization secrets and variables.
5. Run one of the copied wrapper workflows manually, or let the GitVibe server dispatch it.

Users should copy only the files under `examples/consumer/.github`. They should not copy GitVibe's internal action folders such as `investigate/`, `implement/`, or `app/`.

The copied wrapper workflows call the public reusable workflows from this repository:

```yaml
jobs:
  develop:
    uses: git-vibe/actions/.github/workflows/develop.yml@main
```

So consumer repositories keep a small local workflow entry point, while the pipeline implementation stays versioned in `git-vibe/actions`.
Reusable workflows always operate on the repository where the workflow run starts (`github.repository`). GitVibe does not accept a separate `owner/repo` workflow input.
The reusable workflows checkout the GitVibe action source separately. Consumer calls default to `git-vibe/actions@main`; direct `workflow_dispatch` runs in this repository default to the current repository and ref.

## Secrets And Variables

Secrets belong in GitHub repository or organization secrets, not in `.github/git-vibe.yml`.

Required GitHub secrets:

```text
GITVIBE_AI_API_KEY
GITVIBE_GITHUB_TOKEN
WEBHOOK_SECRET
```

`GITVIBE_AI_API_KEY` is the API key for the configured AI provider or OpenAI-compatible proxy.
`GITVIBE_GITHUB_TOKEN` should be a fine-grained PAT scoped to the repository. The self-hosted server uses it for webhook-side GitHub writes, and reusable workflows use it for branch and pull request writes.
`WEBHOOK_SECRET` is the shared secret configured on the GitHub repository webhook. The deploy workflow maps it to the container runtime variable `GITHUB_WEBHOOK_SECRET`.

Optional CLI session secrets:

```text
CODEX_AUTH_JSON
CLAUDE_CODE_OAUTH_TOKEN
```

Useful variables:

```text
GITVIBE_AI_MODEL
GITVIBE_AI_BASE_URL
GITVIBE_DISCUSSION_CATEGORY
GITVIBE_RUNNER
GITVIBE_LOG_LEVEL
```

API-key based OpenAI, Anthropic, OpenAI-compatible proxy, or Codex API style
providers should go through the AI SDK/agentool adapter. The CLI adapters are for
session-style tools only: Codex uses `CODEX_AUTH_JSON`, and Claude Code uses
`CLAUDE_CODE_OAUTH_TOKEN`.

Choose which adapter runs each process in `.github/git-vibe.yml` with
`ai.profiles` and `ai.stages`. Profiles define adapter/model/reasoning settings;
stages reference profile names.

Required self-hosted server runtime variables:

```text
GITHUB_WEBHOOK_SECRET
GITVIBE_GITHUB_TOKEN
```

Optional self-hosted server runtime variables:

```text
GITHUB_API_URL
GITHUB_REPOSITORY
GITVIBE_DISCUSSION_CATEGORY
GITVIBE_DISPATCH_REF
```

When deploying through GitHub Actions, set the GitHub secret as `WEBHOOK_SECRET`; the deploy workflow exports it as `GITHUB_WEBHOOK_SECRET` for Docker Compose.
Do not create a repository secret or variable named `GITHUB_REPOSITORY`. GitHub Actions already provides it to workflow steps, and Docker Compose forwards that existing value into the container so startup preflight can check Discussions before the first webhook arrives. Manual Docker deployments may set `GITHUB_REPOSITORY=owner/repo` to enable the same startup preflight; if omitted, GitVibe still learns the repository from incoming webhook payloads.

## Timeouts

Default workflow budgets:

- investigation, refinement, validation, review: `60` minutes
- implementation and PR feedback remediation: `120` minutes
- PR creation/linking: `15` minutes

Default AI turn budgets:

- normal stages: `90` turns
- implementation and PR feedback remediation: `120` turns

Use the narrowest fine-grained PAT permissions that still allow GitVibe to dispatch workflows, create branches, update issues and discussions, and open pull requests.

## Webhook Setup

Create a repository webhook with:

```text
Payload URL: https://git-vibe.markhuang.ai/webhooks
Content type: application/json
Secret: same value as WEBHOOK_SECRET
SSL verification: enabled
```

Select individual events:

```text
Issues
Issue comments
Sub-issues
Discussions
Discussion comments
Pull requests
Pull request reviews
Pull request review comments
Pull request review threads
```

Do not use "Send me everything"; GitVibe only needs the curated event set above.

## Commands

Use `@git-vibe` in issues, discussions, and pull requests:

```text
@git-vibe investigate
@git-vibe summarize
@git-vibe validate
@git-vibe materialize
@git-vibe approve
@git-vibe start
@git-vibe address-feedback
```

`/git-vibe ...` is reserved as an optional compatibility path for Actions-native slash command mode.

## App Server

The self-hosted server source lives in [src/app/server.ts](src/app/server.ts). It verifies GitHub webhook signatures, uses the configured fine-grained PAT for GitHub writes, checks the actor's repository permission, and dispatches reusable workflows.

```bash
corepack pnpm build:app
GITHUB_WEBHOOK_SECRET=... \
GITVIBE_GITHUB_TOKEN=... \
corepack pnpm start
```

## Example Action Usage

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: git-vibe/actions/investigate@main
    with:
      token: ${{ secrets.GITVIBE_GITHUB_TOKEN }}
      issue-number: "123"
```

## Example Reusable Workflow Usage

```yaml
jobs:
  git-vibe-develop:
    uses: git-vibe/actions/.github/workflows/develop.yml@main
    with:
      issue-number: "123"
      runner: self-hosted
    secrets:
      GITVIBE_GITHUB_TOKEN: ${{ secrets.GITVIBE_GITHUB_TOKEN }}
```

Set `runner` to a self-hosted label if the consumer repo should run GitVibe on its own runners.
Implementation branches are deterministic and issue-scoped: `git-vibe/{issue-number}`.
For source-repo testing, dispatch `investigate.yml`, `summarize.yml`, `validate.yml`, `materialize.yml`, `develop.yml`, or `address-feedback.yml` directly. Leave `action-repository` and `action-ref` empty to test the current repository and ref.

## Current Status

This repository contains the TypeScript GitVibe app implementation, source-built runner actions, stage prompts, JSON Schema contracts, shared runtime helpers, and reusable workflow entry points. App and runner code are separated under `src/app` and `src/runner`, with common code under `src/shared`. Webhook mode and `ai-sdk-agentool` are implemented first; relay, polling, Actions-native receivers, and additional AI adapters are deferred behind interfaces.

## Development Checks

Local quality commands:

```bash
pnpm format:check
pnpm lint
pnpm build
pnpm test
pnpm coverage
pnpm actionlint
pnpm check
```

Coverage thresholds are enforced by Vitest:

```text
branches: 90%
functions: 90%
lines: 90%
statements: 90%
```

The pre-commit hook runs staged format/lint checks, typecheck, and coverage. The repository CI is PR-only plus manual dispatch, runs coverage before build, and runs on `self-hosted` runners.

Manual AI smoke testing is available through the `AI smoke test` workflow. It can
test an OpenAI-compatible local proxy using `GITVIBE_AI_BASE_URL`,
`GITVIBE_AI_API_KEY`, and `GITVIBE_AI_MODEL`, and can optionally test the Codex CLI
with `CODEX_AUTH_JSON` or a pre-seeded `CODEX_HOME/auth.json` on the runner.

JavaScript/MJS size limits:

```text
max file length: 700 lines
max function length: 100 lines
```

These limits are enforced by ESLint.
