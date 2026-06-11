# GitVibe Server

This is the hosted GitHub App webhook server. The source of truth is
`../src/app/server.ts`; the runtime entry point is `../dist/app/server.js`.

It currently handles:

- `POST /webhooks` with GitHub webhook signature verification.
- `GET /health` for health checks.
- GitVibe label bootstrap for webhook repositories.
- Feature request issue-form intake conversion into linked GitHub Discussions.
- `/git-vibe investigate` on issue comments.
- `/git-vibe materialize` on discussion comments.
- `/git-vibe address-feedback` on pull request comments.
- `/git-vibe ...` as the only supported public command prefix.
- Accepted admin/collaborator comment commands get a `rocket` reaction before workflow dispatch.
- Protected public trigger labels, including `git-vibe:validate`, `git-vibe:investigate`, and `git-vibe:approved`.
- Internal `gvi:*` runtime labels managed by GitVibe.
- GitHub App installation-token-backed GitHub API writes.
- `POST /actions/token` for GitHub Actions OIDC token exchange.
- `POST /actions/codex-auth` for server-side Codex auth bundle writeback.
- Repository permission checks before dispatching workflows.
- Workflow dispatch to reusable GitVibe workflows. Comment commands use queued comments only when reaction acknowledgement fails; protected labels and trusted reviews still use queued comments with exact workflow links when GitHub returns them.

GitVibe uses GitHub App webhooks plus short-lived installation tokens. The App
bot appears as the actor for GitHub writes performed by the server and
workflows.

## Environment

Required runtime values:

```text
GITHUB_APP_ID=...
GITHUB_WEBHOOK_SECRET=...
GITVIBE_APP_PRIVATE_KEY=...
```

Optional runtime values:

```text
GITHUB_API_URL=https://api.github.com
GITVIBE_ACTIONS_OIDC_AUDIENCE=https://git-vibe.markhuang.ai/actions/token
GITVIBE_DISCUSSION_CATEGORY=Ideas
```

Use the private key generated for the registered GitHub App. Do not configure a
customer repository PAT for hosted GitVibe.
The registered App needs repository permissions for Actions read/write, Checks
read, Contents read/write, Discussions read/write, Issues read/write, Pull
requests read/write, Secrets read/write, and Workflows read/write. Customer
repositories do not create GitHub environments for hosted auth.
Workflow dispatch uses the repository variable `GITVIBE_BASE_BRANCH`; empty or
missing means the repository default branch.
When deploying through GitHub Actions, store the App ID as repository variable
`GITVIBE_GITHUB_APP_ID`, the App private key as `GITVIBE_APP_PRIVATE_KEY`, and
the webhook secret as `WEBHOOK_SECRET`; the deploy workflow maps them to runtime
environment variables.
Repository setup checks run from GitHub App installation webhooks and repository
webhooks, not from deploy-time repository environment variables.

## Run

```bash
corepack pnpm build:app
corepack pnpm start
```

## Docker

```bash
docker compose -f docker-compose.yml up -d
```

The compose deployment expects runtime values from the host environment. In CI/CD,
the `GitVibe app deploy` workflow builds `ghcr.io/markhuangai/git-vibe`, then runs
the compose deployment on the self-hosted runner.
The container listens on port `3000`; change the host-side mapping in Compose or
an override file instead of setting a `PORT` variable.
If the runner mounts a host-specific override file at
`/opt/git-vibe/docker-compose.override.yml`, the deploy workflow includes it
automatically for reverse proxy labels, external networks, and host-local settings.
