# git-vibe-setup

Local initializer for GitVibe consumer repositories.

```bash
npx git-vibe-setup setup
```

The `setup` command writes `.github` and `.git-vibe` starter files, pins reusable
workflow refs to the latest stable `markhuangai/git-vibe` release, and fails
before writing if release lookup or target-file validation fails.

```bash
npx git-vibe-setup update
```

The `update` command rewrites only `.github/workflows/*.yml` GitVibe wrapper
files from the latest package templates and pins them to the latest stable
release. It does not update `.github/git-vibe.yml`, `.git-vibe`, secrets, or
variables, and it refuses to overwrite workflow files that do not look like
GitVibe wrappers.
