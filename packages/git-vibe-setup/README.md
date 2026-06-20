# git-vibe-setup

Local initializer for GitVibe consumer repositories.

```bash
npx git-vibe-setup setup
```

The `setup` command fetches `examples/consumer` from the latest stable
`markhuangai/git-vibe` release, writes `.github` and `.git-vibe` starter files,
pins reusable workflow refs to that release, and fails before writing if release
lookup, starter fetch, or target-file validation fails.

When `GITHUB_TOKEN` or `GH_TOKEN` is set, `git-vibe-setup` uses it only to
authenticate GitHub release and starter-file reads. This avoids anonymous API
throttling in CI and shared-network environments.

```bash
npx git-vibe-setup update
```

The `update` command fetches `examples/consumer` from the latest stable
`markhuangai/git-vibe` release, migrates supported `.github/git-vibe.yml`
settings in place, rewrites `.github/workflows/*.yml` GitVibe wrapper files,
and pins workflow refs to that release. It does not update `.git-vibe`,
secrets, or variables, and it refuses to overwrite workflow files that do not
look like GitVibe wrappers.

To test a specific release or prerelease from a consumer repository, pass the
release tag explicitly:

```bash
npx git-vibe-setup update --release v3.0.4-rc.1
```

To let automatic latest-release lookup choose prereleases, opt in explicitly:

```bash
npx git-vibe-setup update --include-prereleases
```
