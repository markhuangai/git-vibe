# GitVibe Server

This is the self-hosted repository webhook server. The source of truth is
`../src/app/server.ts`; `app/server.mjs` loads the compiled output from
`../dist/app/server.js`.

It currently handles:

- `POST /webhooks` with GitHub webhook signature verification.
- `GET /health` for health checks.
- GitVibe label bootstrap for webhook repositories.
- Feature request issue-form intake conversion into linked GitHub Discussions.
- `@git-vibe investigate` on issue comments.
- `@git-vibe start` on issue comments.
- `@git-vibe address-feedback` on pull request comments.
- `/git-vibe ...` as an optional compatibility command for Actions-native slash command mode.
- Protected `git-vibe:*` issue labels, including `git-vibe:approved`.
- Fine-grained PAT-backed GitHub API writes.
- Repository permission checks before dispatching workflows.
- Workflow dispatch to reusable GitVibe workflows.

GitVibe uses repository webhooks plus a fine-grained PAT. The PAT owner appears as
the actor for GitHub writes performed by the server and workflows.

## Environment

Required runtime values:

```text
GITHUB_WEBHOOK_SECRET=...
GITVIBE_GITHUB_TOKEN=...
```

Optional runtime values:

```text
GITHUB_API_URL=https://api.github.com
GITHUB_REPOSITORY=owner/repo
GITVIBE_DISPATCH_REF=main
GITVIBE_DISCUSSION_CATEGORY=Ideas
```

Use a fine-grained PAT scoped only to the repositories managed by this server.
When deploying through GitHub Actions, store the webhook secret as repository secret
`WEBHOOK_SECRET`; the deploy workflow maps it to `GITHUB_WEBHOOK_SECRET`.
Do not create a repository secret or variable named `GITHUB_REPOSITORY`. GitHub
Actions provides it to the deploy workflow automatically, and Docker Compose
passes that existing value into the container. Manual Docker deployments may set
`GITHUB_REPOSITORY=owner/repo` to enable startup preflight; otherwise GitVibe
checks repository-specific setup when webhooks arrive.

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
the `GitVibe app deploy` workflow builds `ghcr.io/z-m-huang/git-vibe`, then runs
the compose deployment on the self-hosted runner.
The container listens on port `3000`; change the host-side mapping in Compose or
an override file instead of setting a `PORT` variable.
If the runner mounts a host-specific override file at
`/opt/git-vibe/docker-compose.override.yml`, the deploy workflow includes it
automatically for reverse proxy labels, external networks, and host-local settings.
