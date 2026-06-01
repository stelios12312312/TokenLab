#!/usr/bin/env bash
# Pre-commit hook for Iterative Planner
# Install: cp .agent/skills/iterative-planner/scripts/pre-commit-hook.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#
# Delegates to the shared pre_commit_policy.mjs helper so the legacy wrapper and
# the installed hook enforce the same scoped blocking behavior.

set -euo pipefail

SKILL_DIR=".agent/skills/iterative-planner"
RUN_NODE="$SKILL_DIR/scripts/hooks/run-node.sh"

if [ ! -d "$SKILL_DIR" ]; then
  exit 0
fi

if [ -f "$RUN_NODE" ]; then
  sh "$RUN_NODE" "$SKILL_DIR/scripts/pre_commit_policy.mjs" pre-commit
else
  node "$SKILL_DIR/scripts/pre_commit_policy.mjs" pre-commit
fi
