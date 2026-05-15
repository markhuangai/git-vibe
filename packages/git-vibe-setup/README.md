# git-vibe-setup

Local initializer for GitVibe consumer repositories.

```bash
npx --package=git-vibe-setup git-vibe-setup
```

The command writes `.github` and `.git-vibe` starter files, pins reusable
workflow refs to the latest stable `markhuangai/git-vibe` release, and fails
before writing if release lookup or target-file validation fails.
