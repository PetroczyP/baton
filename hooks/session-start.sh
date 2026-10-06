#!/bin/sh
# Torch's SessionStart hook: load the project's handoff, or say plainly why it can't run.
if ! command -v python3 >/dev/null 2>&1; then
  echo "torch: python3 (3.9 or newer) was not found, so the last handoff was not loaded" >&2
  exit 1
fi
exec python3 "$CLAUDE_PLUGIN_ROOT/hooks/handoff-autoload.py" session-start
