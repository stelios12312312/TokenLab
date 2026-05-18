#!/bin/sh
# Resolve and run Node from non-interactive shells that may not source nvm.

set -u

if [ "$#" -eq 0 ]; then
  echo "ERROR: run-node.sh requires a Node script or Node arguments." >&2
  exit 2
fi

if [ -n "${ITERATIVE_PLANNER_NODE:-}" ] && [ -x "${ITERATIVE_PLANNER_NODE:-}" ]; then
  exec "$ITERATIVE_PLANNER_NODE" "$@"
fi

if command -v node >/dev/null 2>&1; then
  exec "$(command -v node)" "$@"
fi

HOME_DIR="${HOME:-}"
for p in \
  /opt/homebrew/bin \
  /usr/local/bin \
  "$HOME_DIR/.nvm/versions/node"/*/bin \
  "$HOME_DIR/.volta/bin" \
  "$HOME_DIR/.fnm/aliases/default/bin" \
  "$HOME_DIR/.asdf/shims"
do
  if [ -n "$p" ] && [ -x "$p/node" ]; then
    exec "$p/node" "$@"
  fi
done

echo "ERROR: node not found. Set ITERATIVE_PLANNER_NODE to an absolute node binary, or install Node via nvm/Homebrew/Volta/fnm/asdf." >&2
exit 127
