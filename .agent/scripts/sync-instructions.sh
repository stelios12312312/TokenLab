#!/usr/bin/env bash
# sync-instructions.sh
# Keeps GEMINI.md and AGENTS.md in sync with CLAUDE.md (the canonical source).
# Run this any time you update CLAUDE.md.
#
# Usage: bash .agent/scripts/sync-instructions.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SRC="$ROOT/CLAUDE.md"

if [ ! -f "$SRC" ]; then
  echo "ERROR: $SRC not found." >&2
  exit 1
fi

cp "$SRC" "$ROOT/GEMINI.md"
cp "$SRC" "$ROOT/AGENTS.md"

echo "Synced:"
echo "  CLAUDE.md → GEMINI.md"
echo "  CLAUDE.md → AGENTS.md"
