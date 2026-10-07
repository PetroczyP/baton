# Torch privacy policy

Effective 7 October 2026.

Torch is a Claude Code plugin that runs entirely on your computer, inside Claude Code. It has no server, account, analytics or telemetry, and it makes no network requests of its own.

## What Torch reads

- `handoff-before-clear.md` at the root of the project where you start Claude Code, and the project's git state, through the two `git status` commands listed in the [README](README.md#what-torch-sends-reads-runs-and-writes).
- From your session: its id, the folder you started in, and whether it is new or cleared; for each message, whether you sent it; for your first message, only whether it starts with `/torch:load-handoff`. Torch stores and logs no message text.
- When you run `/torch:load-handoff`: the handoff, or else one Torch couldn't finish archiving or the newest archived one, the project's `CLAUDE.md`, and the files the handoff lists.

## What Torch writes, and how long it stays

- **`handoff-before-clear.md`,** in your project, when you run `/torch:save-handoff`. The next save overwrites it.
- **Archived handoffs,** in `<project>/.claude/handoff-archive/`. They stay until you delete them; uninstalling Torch does not remove them.
- **A handoff Torch couldn't finish moving,** as a hidden `.handoff-claim-….md` file at the project root, which Torch names when it happens. It stays until you delete it.
- **Session records,** in Claude Code's storage for Torch (`~/.claude/plugins/store/torch_….json`). Each holds a handoff's path, its SHA-256 hash, its planned archive path, its save time, the git drift summary, the record's own time and a random id for the run of Torch that wrote it, under the session id; no handoff or message text. Torch normally deletes a record with the first message you send in its session, and at each session start in which it runs it tries to delete any record more than 30 days old. If the store refuses, a record can stay longer; there is no fixed deletion date. Claude Code deletes the whole file once no session has used it for `cleanupPeriodDays` (30 days by default). Uninstalling Torch may leave the file in place; you can delete it at any time.

## What reaches Claude, and what Torch runs

Torch makes no network requests of its own. With your first message it adds the handoff's text (or its path, when it is too large), where it was archived, its save time and the git drift summary to your Claude Code conversation. Torch does not check who wrote the file. Your Claude service processes that under your agreement with Anthropic or with your model provider, like everything else in the session. Torch does not send it, or anything else, to any other destination.

To move the handoff into the archive, Torch runs `mkdir`, `mv`, `link` and `rm` on your computer, as you and outside Claude Code's sandbox. They receive fixed options and file paths only, never the handoff's text or anything from your conversation, and none of them uses the network. The [README](README.md#what-torch-sends-reads-runs-and-writes) lists each command exactly as it runs.

## Contact

Ask questions in [GitHub issues](https://github.com/PetroczyP/torch/issues). For a security concern, see [SECURITY.md](SECURITY.md).
