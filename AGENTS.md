# Codex Context

## Project

GitVibe is a repository webhook server plus reusable GitHub Actions/workflows for AI-assisted development through issues, discussions, labels, workflow runs, branches, and pull requests.

The canonical product/architecture plan is [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md).

## Workflow

- Do not create commits unless the user explicitly asks for a commit.
- Use `/git-vibe ...` as the only public command form.
- Do not support `@git-vibe ...`; it looks like a GitHub account mention.
- This repository's own CI runs on `self-hosted` runners only.
- Consumer example workflows may remain configurable because consumer repos may not have self-hosted runners.

## Tooling

- Package manager: `pnpm` via Corepack.
- If `pnpm` is not on `PATH`, use `corepack pnpm`.
- Do not use `npm install` or create `package-lock.json`.
- JavaScript/MJS size limits are enforced through ESLint.

## Checks

Run the full local gate before considering work complete:

```bash
corepack pnpm check
```

Individual checks:

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm build
corepack pnpm test
corepack pnpm coverage
corepack pnpm actionlint
corepack pnpm audit --prod
```

Quality policies:

- Minimum coverage thresholds: branches 90%, functions 90%, lines 90%, statements 90%.
- Maximum JavaScript/MJS file length: 700 lines.
- Maximum JavaScript/MJS function length: 100 lines.
- Mock external boundaries in tests, not internal decisions.

## Editing

- Keep files focused and under the size limits.
- Prefer deterministic code for GitHub writes; AI should return structured results that GitVibe validates and renders.
- Preserve PAT safety guidance: scope the token narrowly, never log it, and keep GitHub writes in deterministic GitVibe code.
