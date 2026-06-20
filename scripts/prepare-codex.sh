#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

export_path() {
  local executable="$1"
  "$executable" --version >/dev/null
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "GITVIBE_CODEX_PATH=$executable" >> "$GITHUB_ENV"
  fi
  echo "Using Codex executable at $executable"
}

if [ -n "${GITVIBE_CODEX_PATH:-}" ]; then
  if [ ! -x "$GITVIBE_CODEX_PATH" ]; then
    echo "::error::GITVIBE_CODEX_PATH is not executable: $GITVIBE_CODEX_PATH"
    exit 1
  fi
  export_path "$GITVIBE_CODEX_PATH"
  exit 0
fi

if resolved="$(node "$repo_dir/scripts/resolve-codex-path.mjs" 2>/dev/null)" && [ -n "$resolved" ]; then
  export_path "$resolved"
  exit 0
fi

if command -v codex >/dev/null 2>&1; then
  export_path "$(command -v codex)"
  exit 0
fi

case "$(uname -s)" in
  Darwin|Linux) ;;
  *)
    echo "::error::GitVibe Codex setup supports Linux and macOS runners only."
    exit 1
    ;;
esac

echo "::error::Codex is not available. Reinstall @openai/codex-sdk with optional dependencies, or set GITVIBE_CODEX_PATH."
exit 1
