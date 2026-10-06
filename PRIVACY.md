# Baton privacy policy

Effective 6 October 2026.

Baton is a Claude Code plugin that runs entirely on your computer. It has no server, account, analytics or telemetry, and it makes no network requests of its own.

## What Baton reads

- `handoff-before-clear.md` at the root of the project where you start Claude Code, and the project's git state, through `git status` and the other git commands listed in the [README](README.md#what-baton-reads-runs-and-writes).
- When you run `/baton:load-handoff`: the handoff, or the newest archived one, the project's `CLAUDE.md`, and the files the handoff lists.

## What Baton writes, and how long it stays

- **`handoff-before-clear.md`,** in your project, when you run `/baton:save-handoff`. The next save overwrites it.
- **Archived handoffs,** in `<project>/.claude/handoff-archive/`. They stay until you delete them; uninstalling Baton does not remove them.
- **Session records,** in Claude Code's data folder for this plugin (`~/.claude/plugins/data/<baton id>/sessions/`). Each holds a handoff's path, its SHA-256 hash and its planned archive path. A record is deleted on the session's first message. A record whose session never had one is deleted at the first session start in which Baton runs once the record is more than 30 days old. Uninstalling Baton deletes the folder.

## What reaches Claude

A handoff is a summary of your earlier session that Claude wrote at your request. When Baton loads it, its text becomes part of your Claude Code conversation. Your Claude service processes it under your agreement with Anthropic or with your model provider, like everything else in the session. Baton does not send it, or anything else, to any other destination.

## Contact

Ask questions in [GitHub issues](https://github.com/PetroczyP/baton/issues). For a security concern, see [SECURITY.md](SECURITY.md).
