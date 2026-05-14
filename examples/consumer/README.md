# GitVibe Consumer Example

Copy the `.github` and `.git-vibe` directories from this folder into a repository that should use GitVibe.

```bash
cp -R examples/consumer/.github /path/to/consumer-repo/.github
cp -R examples/consumer/.git-vibe /path/to/consumer-repo/.git-vibe
```

Then configure repository or organization secrets and variables as described in the root `README.md`.

Use `GITVIBE_AI_ENV_JSON.example.json` as the shape for the
`GITVIBE_AI_ENV_JSON` secret. Do not commit real token values.
