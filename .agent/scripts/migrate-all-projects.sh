#!/usr/bin/env bash
# migrate-all-projects.sh
# Propagates Rule 0, the sync script, and root instruction files (CLAUDE.md/GEMINI.md/AGENTS.md)
# to all projects registered in .project_registry.json.
#
# Safe to re-run. Never overwrites existing CLAUDE.md content.
#
# Usage: bash .agent/scripts/migrate-all-projects.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLANNER_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILL_PATH="$PLANNER_ROOT/.agent/skills/iterative-planner"
REGISTRY="$SKILL_PATH/config/.project_registry.json"

resolve_node() {
  if [ -n "${ITERATIVE_PLANNER_NODE:-}" ] && [ -x "${ITERATIVE_PLANNER_NODE:-}" ]; then
    printf '%s\n' "$ITERATIVE_PLANNER_NODE"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local p
  for p in \
    /opt/homebrew/bin \
    /usr/local/bin \
    "$HOME/.nvm/versions/node"/*/bin \
    "$HOME/.volta/bin" \
    "$HOME/.fnm/aliases/default/bin" \
    "$HOME/.asdf/shims"
  do
    if [ -x "$p/node" ]; then
      printf '%s\n' "$p/node"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(resolve_node)" || {
  echo "ERROR: node is required. Set ITERATIVE_PLANNER_NODE or install Node via nvm/Homebrew/Volta/fnm/asdf." >&2
  exit 127
}

if [ ! -f "$REGISTRY" ]; then
  echo "ERROR: Registry not found at $REGISTRY" >&2
  exit 1
fi

# Export vars so the node heredoc can read them
export PLANNER_ROOT REGISTRY

# Delegate everything to node — avoids shell word-splitting on paths with spaces
"$NODE_BIN" --input-type=module << 'JSEOF'
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';

const PLANNER_ROOT    = process.env.PLANNER_ROOT;
const REGISTRY        = process.env.REGISTRY;
const SYNC_SCRIPT     = join(PLANNER_ROOT, '.agent/scripts/sync-instructions.sh');
const MIGRATE_SCRIPT  = join(PLANNER_ROOT, '.agent/skills/iterative-planner/scripts/migrate.mjs');
const TEMPLATE_CLAUDE = join(PLANNER_ROOT, 'CLAUDE.md');
const RULES_SRC       = join(PLANNER_ROOT, '.agent/rules.md');
const RULE0_MARKER    = '## 0. Use the Iterative Planner';

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));

// Extract Rule 0 block from the planner's own rules.md
const rulesContent = readFileSync(RULES_SRC, 'utf8');
const r0Start = rulesContent.indexOf(RULE0_MARKER);
const r0End   = rulesContent.indexOf('\n## 1.', r0Start);
const rule0Block = rulesContent.slice(r0Start, r0End).trimEnd();

let updated = 0, skipped = 0;

console.log('=== Iterative Planner — cross-project migration ===');
console.log(`Registry: ${REGISTRY}\n`);

for (const entry of registry.projects) {
  const PROJECT = entry.path;

  if (PROJECT === PLANNER_ROOT) {
    console.log(`[ SKIP ] ${PROJECT}  (planner repo — already up to date)`);
    continue;
  }

  if (!existsSync(PROJECT)) {
    console.log(`[ WARN ] ${PROJECT}  (directory not found — skipping)`);
    skipped++;
    continue;
  }

  console.log(`[ .... ] ${PROJECT}`);

  const agentScripts  = join(PROJECT, '.agent/scripts');
  const projectSync   = join(agentScripts, 'sync-instructions.sh');
  const projectRules  = join(PROJECT, '.agent/rules.md');
  const projectClaude = join(PROJECT, 'CLAUDE.md');

  // 1. Install sync script
  mkdirSync(agentScripts, { recursive: true });
  copyFileSync(SYNC_SCRIPT, projectSync);
  chmodSync(projectSync, 0o755);
  console.log('         sync-instructions.sh — installed');

  // 2. Inject Rule 0 into rules.md if missing
  if (existsSync(projectRules)) {
    const content = readFileSync(projectRules, 'utf8');
    if (content.includes(RULE0_MARKER)) {
      console.log('         rules.md — Rule 0 already present');
    } else {
      const sepIdx = content.indexOf('\n---\n');
      let newContent;
      if (sepIdx !== -1) {
        newContent = content.slice(0, sepIdx + 5) + '\n' + rule0Block + '\n\n---\n\n' + content.slice(sepIdx + 5);
      } else {
        const nl = content.indexOf('\n');
        newContent = content.slice(0, nl + 1) + '\n' + rule0Block + '\n\n---\n\n' + content.slice(nl + 1);
      }
      writeFileSync(projectRules, newContent);
      console.log('         rules.md — Rule 0 injected');
    }
  } else {
    console.log('         rules.md — not found, skipping Rule 0 injection');
  }

  // 3. Create CLAUDE.md from template if missing
  if (!existsSync(projectClaude)) {
    copyFileSync(TEMPLATE_CLAUDE, projectClaude);
    console.log('         CLAUDE.md — created from template');
  } else {
    console.log('         CLAUDE.md — already exists (not overwritten)');
  }

  // 4. Refresh managed root-instruction snapshots without overwriting host-owned text
  execFileSync(process.execPath, [MIGRATE_SCRIPT, 'sync-instructions', PROJECT], {
    cwd: PLANNER_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  console.log('         root instruction snapshots — synced');

  updated++;
  console.log('         [ DONE ]\n');
}

console.log('=== Summary ===');
console.log(`  Updated : ${updated}`);
console.log(`  Skipped : ${skipped}`);
JSEOF
