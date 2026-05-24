# git-vibe-setup

Local initializer for GitVibe consumer repositories.

```bash
npx git-vibe-setup setup
```

The `setup` command fetches `examples/consumer` from the latest stable
`markhuangai/git-vibe` release, writes `.github` and `.git-vibe` starter files,
pins reusable workflow refs to that release, and fails before writing if release
lookup, starter fetch, or target-file validation fails.

```bash
npx git-vibe-setup update
```

The `update` command fetches `examples/consumer` from the latest stable
`markhuangai/git-vibe` release, rewrites only `.github/workflows/*.yml` GitVibe
wrapper files, and pins them to that release. It does not update
`.github/git-vibe.yml`, `.git-vibe`, secrets, or variables, and it refuses to
overwrite workflow files that do not look like GitVibe wrappers.
