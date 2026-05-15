# GitVibe Project Plan

This file is the index for the GitVibe plan. The detailed plan is split into focused documents so each file stays small and maintainable.

## Documents

- [Architecture](ARCHITECTURE.md): system shape, webhook/PAT token model, event delivery modes, and consumer setup.
- [Workflow](WORKFLOW.md): issue/discussion lifecycle, public commands, labels, bug and feature flows, PR feedback, and traceability.
- [AI](AI.md): context assembly, AI stage contracts, execution rules, provider strategy, tool policy, and budgets.
- [Development](DEVELOPMENT.md): repository shape, test plan, AI smoke tests, quality gates, and assumptions.

## Quick Summary

GitVibe is a self-hostable repository webhook server plus reusable GitHub Actions/workflows for turning GitHub issues, discussions, labels, and pull requests into an AI-assisted development pipeline.

The public action namespace should be:

```yaml
uses: markhuangai/git-vibe/investigate@v2
```

Reusable full pipelines should be published from the same repository:

```yaml
jobs:
  git-vibe-develop:
    uses: markhuangai/git-vibe/.github/workflows/develop.yml@v2
```

Core defaults:

- `/git-vibe ...` is the public command form for command-triggered workflows.
- Bugs are investigated before any implementation approval.
- Feature requests start in discussions and are materialized into issues only after refinement and protected approval.
- GitHub-native labels, comments, links, and hidden markers are the source of truth.
- AI returns structured results; deterministic GitVibe code performs GitHub writes.
- App, runner, and shared TypeScript live in one package but separate source boundaries so runner-only changes do not redeploy the app.
- The repository uses pnpm, TypeScript source, runner-built action runtimes, PR-only CI on the `docker-runner` self-hosted runner label, 90% function/line/statement coverage, and ESLint-enforced JavaScript/MJS size limits of 700 lines per file and 100 lines per function.
