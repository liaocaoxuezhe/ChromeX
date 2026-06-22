#!/usr/bin/env bash
# =============================================================================
# Sync SKILL.md from skills/ (single source of truth) to all replica directories
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

SOURCE="$ROOT_DIR/skills/link2chrome-browser-mcp/SKILL.md"

REPLICAS=(
  "$ROOT_DIR/.claude/skills/link2chrome-browser-mcp/SKILL.md"
  "$ROOT_DIR/.codex/skills/link2chrome-browser-mcp/SKILL.md"
  "$ROOT_DIR/.agents/skills/link2chrome-browser-mcp/SKILL.md"
  "$ROOT_DIR/.kimi-code/skills/link2chrome-browser-mcp/SKILL.md"
)

if [[ ! -f "$SOURCE" ]]; then
  echo "Error: source file not found: $SOURCE" >&2
  exit 1
fi

for replica in "${REPLICAS[@]}"; do
  replica_dir="$(dirname "$replica")"
  if [[ ! -d "$replica_dir" ]]; then
    mkdir -p "$replica_dir"
    echo "Created directory: $replica_dir"
  fi
  cp "$SOURCE" "$replica"
  echo "Synced: $replica"
done

echo "All SKILL.md replicas are in sync."
