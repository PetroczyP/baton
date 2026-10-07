# Torch privacy policy

Effective 7 October 2026.

Torch is a Claude Code plugin that runs entirely on your computer, inside Claude Code. It has no server, account, analytics or telemetry, and it makes no network requests of its own.

## What Torch reads

- `handoff-before-clear.md` at the root of the project where you start Claude Code, and the project's git state, through `git status` and the other git commands listed in the [README](README.md#what-torch-reads-runs-and-writes).
- When you run `/torch:load-handoff`: the handoff, or the newest archived one, the project's `CLAUDE.md`, and the files the handoff lists.

## What Torch writes, and how long it stays

- **`handoff-before-clear.md`,** in your project, when you run `/torch:save-handoff`. The next save overwrites it.
- **Archived handoffs,** in `<project>/.claude/handoff-archive/`. They stay until you delete them; uninstalling Torch does not remove them.
- **A handoff Torch couldn't finish moving,** as a hidden `.handoff-claim-….md` file at the project root, which Torch names when it happens. It stays until you delete it.
- **Session records,** in Claude Code's storage for Torch (`~/.claude/plugins/store/torch_….json`). Each holds a handoff's path, its SHA-256 hash, its planned archive path and the time it was saved. A record is deleted on the session's first message. A record whose session never had one is deleted at the first session start in which Torch runs once the record is more than 30 days old; there is no fixed deletion date. Claude Code deletes the whole file once no session has used it for `cleanupPeriodDays` (30 days by default). Uninstalling Torch may leave the file in place; you can delete it at any time.

## What reaches Claude

When Torch loads a handoff, its text becomes part of your Claude Code conversation. Torch does not check who wrote the file. Your Claude service processes it under your agreement with Anthropic or with your model provider, like everything else in the session. Torch does not send it, or anything else, to any other destination.

## Contact

Ask questions in [GitHub issues](https://github.com/PetroczyP/torch/issues). For a security concern, see [SECURITY.md](SECURITY.md).
