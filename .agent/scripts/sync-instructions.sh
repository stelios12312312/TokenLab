#!/usr/bin/env bash
# sync-instructions.sh
# Refreshes planner-managed root instruction snapshots without overwriting
# host-owned content around the managed block.
#
# Usage: bash .agent/scripts/sync-instructions.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATE="$ROOT/.agent/skills/iterative-planner/scripts/migrate.mjs"

if [ ! -f "$MIGRATE" ]; then
  echo "ERROR: $MIGRATE not found." >&2
  exit 1
fi

node "$MIGRATE" sync-instructions "$ROOT"
