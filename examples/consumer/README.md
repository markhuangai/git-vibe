# GitVibe Consumer Example

`git-vibe-setup` installs this starter into a consumer repository:

```bash
npx --package=git-vibe-setup git-vibe-setup
```

The installer copies `.github` and `.git-vibe`, rewrites reusable workflow refs
to the latest stable GitVibe release tag, and fails closed if GitHub release
lookup or target-file validation cannot complete before writing.

It will not overwrite existing target files. Remove any existing GitVibe starter
files before running setup again.

Then configure repository or organization secrets and variables as described in
the root `README.md`.

Use `GITVIBE_AI_ENV_JSON.example.json` as the shape for the
`GITVIBE_AI_ENV_JSON` secret. Do not commit real token values.
