#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

export_path() {
  local executable="$1"
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "GITVIBE_CLAUDE_CODE_PATH=$executable" >> "$GITHUB_ENV"
  fi
  echo "Using Claude Code executable at $executable"
}

if [ -n "${GITVIBE_CLAUDE_CODE_PATH:-}" ]; then
  if [ ! -x "$GITVIBE_CLAUDE_CODE_PATH" ]; then
    echo "::error::GITVIBE_CLAUDE_CODE_PATH is not executable: $GITVIBE_CLAUDE_CODE_PATH"
    exit 1
  fi
  export_path "$GITVIBE_CLAUDE_CODE_PATH"
  exit 0
fi

if resolved="$(node "$repo_dir/scripts/resolve-claude-code-path.mjs" 2>/dev/null)" && [ -n "$resolved" ]; then
  export_path "$resolved"
  exit 0
fi

if command -v claude >/dev/null 2>&1; then
  export_path "$(command -v claude)"
  exit 0
fi

case "$(uname -s)" in
  Darwin|Linux) ;;
  *)
    echo "::error::GitVibe Claude Code setup supports Linux and macOS runners only."
    exit 1
    ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo "::error::Claude Code is not available and curl is required to install it."
  exit 127
fi

curl -fsSL https://claude.ai/install.sh | bash -s -- stable
hash -r

if command -v claude >/dev/null 2>&1; then
  export_path "$(command -v claude)"
  exit 0
fi

for candidate in "$HOME/.local/bin/claude" "$HOME/.claude/bin/claude" "$HOME/bin/claude"; do
  if [ -x "$candidate" ]; then
    export_path "$candidate"
    exit 0
  fi
done

echo "::error::Claude Code installed, but the claude executable was not found on PATH."
exit 1
