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

`.github/git-vibe.yml` enables the AI prompt-injection gate by default:
`safety.prompt_injection_gate: true`. Set it to `false` only when the
repository owner wants to skip both input and output safety scans.
CodeRabbit comments and reviews are ignored by default. Add more bot logins
with `safety.ignored_authors` only when the repository owner wants GitVibe to
depend on its own review instead of scanning those bots' comments.

Use `GITVIBE_AI_ENV_JSON.example.json` as the shape for the
`GITVIBE_AI_ENV_JSON` secret. If the repository config enables MCP servers, use
`GITVIBE_MCP_ENV_JSON.example.json` as the shape for the optional
`GITVIBE_MCP_ENV_JSON` secret. Do not commit real token values.
