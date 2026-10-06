#!/bin/sh
# Baton's UserPromptSubmit hook. Only a session that loaded a handoff at its start has a record
# here, so most prompts end without starting Python. Without a session id, Python decides.
if [ -n "$CLAUDE_CODE_SESSION_ID" ] && \
   [ ! -f "$CLAUDE_PLUGIN_DATA/sessions/$CLAUDE_CODE_SESSION_ID.json" ]; then
  exit 0
fi
exec python3 "$CLAUDE_PLUGIN_ROOT/hooks/handoff-autoload.py" prompt-submit
