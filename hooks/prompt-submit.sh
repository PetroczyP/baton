#!/bin/sh
# Torch's UserPromptSubmit hook. Only a session that loaded a handoff at its start has a record,
# so most prompts end here without starting Python. The session id is read from the hook input
# with shell built-ins; input it can't read that way goes to Python, which decides.
IFS= read -r input
sid=${input#*\"session_id\"}
sid=${sid#*\"}
sid=${sid%%\"*}
case $sid in
  ''|*[!A-Za-z0-9_-]*) ;;
  *) [ -f "$CLAUDE_PLUGIN_DATA/sessions/$sid.json" ] || exit 0 ;;
esac
{ printf '%s\n' "$input"; cat; } | python3 "$CLAUDE_PLUGIN_ROOT/hooks/handoff-autoload.py" prompt-submit
