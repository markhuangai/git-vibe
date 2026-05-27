# Architecture

## Summary

GitVibe is a self-hostable repository webhook server plus reusable GitHub Actions/workflows for turning GitHub issues, discussions, labels, and pull requests into an AI-assisted development pipeline.

The public action namespace should be:

```yaml
uses: markhuangai/git-vibe/investigate@v3
```

Reusable full pipelines should be published from the same repository:

```yaml
jobs:
  git-vibe-develop:
    uses: markhuangai/git-vibe/.github/workflows/develop.yml@v3
```

Consumer repositories can run jobs on GitHub-hosted runners or self-hosted runners. The current GitVibe orchestrator is hosted by the repository owner, receives GitHub repository webhooks at `/webhooks`, validates permissions, updates GitHub-native state, and dispatches workflows with parameters.

## Runtime Boundaries

GitVibe uses one package and one lockfile, but source is separated by runtime ownership:

- `src/app`: webhook server and repository orchestration logic that ships in the self-hosted Docker image.
- `src/runner`: reusable action runtime, AI stage execution, context assembly, prompt/schema handling, shared branch-update writes, PR creation, and result comments.
- `src/shared`: GitHub API helpers, Discussion helpers, labels, stage definitions, traceability helpers, and common types used by both app and runner.

The Docker image builds only app/shared output. Composite actions build the runner bundle on the GitHub runner before executing a stage. Runner-only changes should not deploy the app unless they also change shared code, package metadata, Docker/deploy files, or app code.

## System Shape

```mermaid
flowchart LR
  U[Guest or contributor] --> GH[GitHub issues, discussions, and PRs]
  M[Admin or collaborator] --> GH

  GH -->|repository webhooks| APP[Self-hosted GitVibe Orchestrator]
  APP -->|validate actor permissions| GH
  APP -->|labels, comments, backlinks, markers| GH
  APP -->|workflow_dispatch| WF[Consumer repo workflow]

  WF -->|uses| GV[markhuangai/git-vibe]
  GV --> SR[No-AI security-review job]
  SR -->|blocked result| GH
  SR -->|allowed| RUNNER[GitHub-hosted or self-hosted runner]

  RUNNER --> CODE[Repository checkout]
  RUNNER --> SAFE[In-runner prompt-injection safety gate]
  SAFE -->|allowed| LLM[Configured hosted LLM provider]
  SAFE -->|blocked result| GH
  RUNNER -->|allowed branch, commits, PR, comments| GH

```

## Webhook And Token Model

The self-hosted server is the orchestrator. The reusable actions and workflows are execution workers. Repository owners configure a GitHub repository webhook and provide a fine-grained PAT to their own server.

```mermaid
sequenceDiagram
  participant GH as GitHub
  participant App as GitVibe Server
  participant WF as GitHub Workflow
  participant Act as markhuangai/git-vibe
  participant API as GitHub API

  GH->>App: Repository webhook: command, label, issue, discussion, or PR event
  App->>API: Validate actor permission
  App->>API: Add label, comment, or state marker
  App->>API: Dispatch workflow with target parameters and run details request
  GH->>WF: Start workflow run
  WF->>Act: Run no-AI security-review job against full target context
  Act->>API: Publish blocked result, or expose allowed output
  WF->>Act: If allowed, run stage job or plan members plus finalizer
  Act->>Act: Run in-runner pre-LLM gate, validate structured output, and run post-output safety gate
  Act->>API: Use configured repository PAT for allowed branch, PR, comments, and metadata writes
```

Use `GITHUB_TOKEN` only for simple read operations. Use the self-hosted server's fine-grained PAT when GitVibe must trigger follow-up workflows, push branches, create pull requests, or avoid `GITHUB_TOKEN` event recursion limits.

The PAT is long-lived, so GitVibe should keep it narrowly scoped to the managed repository and store it only as a GitHub Actions secret plus the self-hosted server runtime secret. Workflows use the same configured PAT for deterministic GitHub writes and must never log or render the token.

The runner treats all GitHub and repository content as untrusted data. Issue
bodies, comments, diffs, repository files, handoffs, and future image/OCR text
can provide evidence, but they cannot grant authority. Every reusable workflow
starts with a no-AI `security-review` job that builds the target context and
must expose `allowed=true` before any planner, role-group member, finalizer, or
stage LLM job can start. The runner also applies the prompt-injection safety
gate before every LLM call, including initial stage calls, validation-repair
calls, and role-group synthesis calls. AI output remains structured advice until
deterministic GitVibe code validates the schema, applies the post-output safety
gate, runs configured checks for write stages, and performs GitHub writes with
the repository PAT. High-risk jailbreak content blocks LLM execution,
privileged state advancement, and write-capable stages behind maintainer
clarification and fresh approval.

Webhook dispatch includes serialized source metadata when automation came from an issue comment, Discussion comment, pull request conversation comment, or submitted pull request review. Runner publishing uses that metadata to choose Discussion `replyToId` or flat issue/PR comments with a source link. Pull request review-comment replies remain supported for existing metadata, but automatic feedback remediation is triggered by trusted `changes_requested` review submissions rather than individual review-comment webhooks. Protected PR review labels dispatch `review.yml`, then the server removes stale PR state and marks the PR `gvi:reviewing`.

Supported workflow auth modes:

- `webhook-pat`: default self-hosted mode. The server receives repository webhooks and uses a fine-grained PAT scoped to the managed repository.
- `pat`: local fallback where workflows receive a repository PAT directly as `GITVIBE_GITHUB_TOKEN`.

## Event Delivery Modes

Repository webhooks are the implemented production event source when the operator has a reachable HTTPS endpoint. GitHub does not provide a first-party persistent stream where a private client dials out to subscribe to all repository events.

The repository still ships the `event_delivery` config shape used by examples
and future planning, but the current server code implements direct webhook
delivery only. Relay, actions-native receiver, and polling modes are not active
code paths.

```mermaid
flowchart TD
  GH[GitHub events] --> A[Direct webhook mode]
  GH --> B[Webhook relay or tunnel mode]
  GH --> C[Actions-native receiver mode]
  GH --> D[Polling mode]

  A --> O[GitVibe orchestrator]
  B -. planned .-> O
  C -. planned .-> W[GitHub Actions receiver workflow]
  D -. planned .-> O

  W --> O2[GitVibe action logic in runner]
  O --> API[GitHub API and workflow dispatch]
  O2 --> API
```

Implemented and planned modes:

- `webhook`: implemented mode. GitHub sends repository webhooks to a public HTTPS URL owned by the operator.
- `relay`: planned no-domain operator mode. GitHub would send webhooks to a relay such as Smee, Hookdeck, Cloudflare Tunnel, ngrok, or a self-hosted relay; the local GitVibe process would keep an outbound connection to receive events.
- `actions`: planned no-server mode. Consumer repositories would install lightweight receiver workflows triggered by GitHub events and scheduled scans.
- `polling`: planned lowest-infrastructure mode. A local or scheduled GitVibe worker would periodically query issues, discussions, comments, reactions, labels, and workflow runs using ETags/cursors.

Planned defaults:

- Managed or organization deployment: `webhook`.
- Local development: `relay` with Smee or an equivalent tunnel.
- Users with no stable domain and no relay provider: `actions`.
- Reaction-threshold scans: `actions` schedule or `polling`, because reactions do not provide a dependable standalone trigger for every threshold crossing.

Example config shape:

```yaml
event_delivery:
  mode: webhook # webhook | relay | actions | polling
  relay:
    provider: smee
    url_secret: GITVIBE_RELAY_URL
  actions_receiver:
    enabled: false
    scheduled_scan: "*/15 * * * *"
  polling:
    enabled: false
    interval_seconds: 300
```

## Consumer Setup

Consumer repositories do not clone GitVibe's internal action implementation.
They copy small starter `.github` and `.git-vibe` folders and pin GitVibe's
public reusable workflows to the `v3` release tag.

Copy source:

```text
examples/consumer/.github
examples/consumer/.git-vibe
```

Copy destination:

```text
<consumer-repo>/.github
<consumer-repo>/.git-vibe
```

Starter files:

- `.github/git-vibe.yml`: repository-specific GitVibe config.
- `.git-vibe/role-group/*.md`: role definitions used by configured role groups.
- `.github/workflows/investigate.yml`: wrapper for investigation-only runs.
- `.github/workflows/develop.yml`: wrapper for full implementation runs.
- `.github/workflows/review.yml`: wrapper for existing pull request review.
- `.github/workflows/materialize.yml`: wrapper for Discussion-to-issue materialization.
- `.github/workflows/validate.yml`: wrapper for issue or Discussion validation.
- `.github/workflows/address-feedback.yml`: wrapper for PR feedback investigation, conditional remediation, and review.

`develop.yml` and `address-feedback.yml` remain separate orchestrators. They
share runner-level branch-update mechanics for validation, commit, and push, but
`develop.yml` publishes a pull request from the issue branch while
`address-feedback.yml` updates the existing PR head branch and then reruns PR
review.

The wrapper workflows call reusable workflows such as:

```yaml
jobs:
  develop:
    uses: markhuangai/git-vibe/.github/workflows/develop.yml@v3
```

Required repository or organization secrets/variables:

- `GITVIBE_GITHUB_TOKEN`: fine-grained PAT used by the server and workflows for GitHub API access.
- `WEBHOOK_SECRET`: repository webhook shared secret used by the deploy workflow to set runtime `GITHUB_WEBHOOK_SECRET`.
- `GITVIBE_AI_ENV_JSON`: JSON bundle for AI provider auth, endpoints, CLI auth, and provider-specific environment values.
- `GITVIBE_DISCUSSION_CATEGORY`: optional variable used by app deployment for feature Discussion conversion category.
- `GITVIBE_BASE_BRANCH`: optional variable used by reusable workflows as the implementation and review base branch.

Self-hosted server runtime secrets:

- `GITHUB_WEBHOOK_SECRET`: webhook shared secret. In GitHub Actions deployment, this comes from repository secret `WEBHOOK_SECRET`.
- `GITVIBE_GITHUB_TOKEN`: mapped to runtime `GITVIBE_GITHUB_TOKEN`.

Self-hosted server variables:

- `GITVIBE_DISCUSSION_CATEGORY`: preferred Discussion category for converted feature issues, default `Ideas`.
- `GITHUB_REPOSITORY`: optional `owner/repo` used by startup preflight. GitHub Actions provides this automatically during deployment; operators do not create a secret or repository variable for it.
