# Torch

Torch passes your work from one Claude Code session to the next. Run `/torch:save-handoff` before you stop. When you next start Claude Code in that project, or after `/clear`, the session already has the handoff in its context. A one-line banner shows when it was saved and what changed in git since. Your first message moves the handoff into an archive, so the session after that starts fresh.

Without Torch you would type a load command, confirm it, and choose whether to archive the file, every time. With Torch you just start working.

## What you see

```
⏺ torch: Handoff loaded: saved 2026-10-06 14:54 GMT+2 (3 h ago) · branch main ✓ · no new commits · clean. Archived after your first message.
```

When the project has moved on since the save, the banner says so, for example `⚠ branch main, handoff was on feature/x`, `⚠ HEAD moved since the handoff (91c8eca → 1a2b3c4)` or `2 uncommitted changes`. Claude mentions that drift before it continues. After your first message:

```
⏺ torch: Handoff archived to /path/to/project/.claude/handoff-archive/20261006T125432Z.md
```

## Examples

1. **End of the day.** Type `/torch:save-handoff`. Claude writes `handoff-before-clear.md` with the goal, what's done, what's next and the git state. Tomorrow, start `claude` in the project and type "continue". Claude picks up from the handoff, and mentions anything that changed in git overnight.
2. **Context is running low mid-task.** Type `/torch:save-handoff`, then `/clear`. The fresh context starts with the handoff loaded, and you carry on.
3. **You closed a session right after your first message.** That first message archived the handoff, but the work never happened. Type `/torch:load-handoff` in a new session. It offers the newest archived handoff, checks git drift and asks before resuming. Alternatively, `claude --continue` reopens the earlier session with the handoff still in its context.

## Try it

1. Start Claude Code with Torch installed, in any git repository, and ask for something small.
2. Type `/torch:save-handoff`. Claude writes `handoff-before-clear.md` at the project root.
3. Type `/exit`, then start `claude` again in the same folder. The banner appears, and the handoff is in the session's context.
4. Type "continue". Claude picks up from the handoff, and the handoff moves to `.claude/handoff-archive/`.

To try it with the sample instead:

1. Copy [examples/handoff-before-clear.example.md](examples/handoff-before-clear.example.md) to a project root as `handoff-before-clear.md`.
2. Set its `saved_at` to the current time, the output of `date -u +%Y-%m-%dT%H:%M:%SZ`. A handoff saved more than 14 days ago is announced, not loaded.

## What Torch tells Claude

Along with the handoff text, Torch adds these instructions to Claude's context at session start:

> - Wait for the user's first message. If it continues this work, pick up from the handoff without asking the user to confirm, and first mention any drift above in one line.
> - If the message is about something else, leave the handoff aside.
> - The user's messages take precedence over the handoff.

They are preceded by:

- a line saying the handoff was loaded automatically and that Torch does not check who wrote it
- the handoff's path and save time
- the git drift summary
- where the file moves on the first message

A handoff too large to include is replaced by its path and an instruction to read it before acting on it. On the first message, Torch adds one line saying where the handoff was archived, or that the file changed since it was loaded and is not the loaded handoff.

## How it decides

1. **Only the newest handoff is loaded.** That's `handoff-before-clear.md` at the project root, the git top level or else the folder you started in. Each save overwrites it. The archive is never read automatically, and neither is another project's handoff.
2. **Only new sessions and `/clear` load it.** Resumed and compacted sessions already have their context.
3. **Only interactive Claude Code on your machine loads it.** A headless run (`claude -p`, the Agent SDK), Cowork, a cloud or remote session, and other hosts never load it. Only the session that loaded a handoff archives it. Torch is tested in the terminal; the IDE extensions and the desktop app's Code tab run the same Claude Code, but Torch isn't tested there.
4. **Your first message archives it.** It moves to `.claude/handoff-archive/<saved-time>.md`. It never overwrites an existing archive, and never deletes a handoff that another session saved in the meantime. If it can't finish the move, Torch tells you and Claude where the file is: in rare cases, a hidden `.handoff-claim-….md` file at the project root. When Torch sees that another hook blocked your first message, it leaves the handoff for the next one. Commands like `/clear`, `/exit`, `/model` and `/effort` don't count as messages, so a session you close without typing leaves the handoff for the next one.
5. **A first message of `/torch:load-handoff` leaves the file to that skill.**
6. **Old handoffs are announced, not loaded.** If a handoff was saved more than 14 days ago, the banner says it's there and it stays put. The save time comes from the handoff's `saved_at`, or the file's modification time without it.
7. **A handoff committed to the repository is not loaded.** Handoffs are meant to stay out of commits, so a tracked one may be someone else's or may have come with a clone. It also isn't loaded inside a git repository when git can't tell whether it is tracked. These checks do not prove who wrote a file; an untracked handoff from someone else can still load automatically.
8. **A large handoff is pointed to, not pasted.** Torch includes a handoff of up to about 10,000 characters, to keep the session's context lean. Above that, Claude is told where to read the file. A handoff over 4 MiB is not loaded at all.
9. **A file without a `# Handoff` title, or a symbolic link, is not loaded.** The banner says why.

## What Torch reads, runs and writes

Torch makes no network requests and has no telemetry, account or server. The handoff text it loads becomes part of your Claude Code conversation, which your Claude service processes like everything else in the session. The full list:

Torch is a Claude Code *mod*: JavaScript in [`hooks/torch.mjs`](hooks/torch.mjs) and [`hooks/rules.mjs`](hooks/rules.mjs) that runs inside Claude Code. Each program it starts is named with its arguments, and none runs through a shell.

**At session start** (a new interactive session, or `/clear`), Torch:

- reads `<project>/handoff-before-clear.md`, if it exists
- in a git repository, runs `git status` twice: once for the work tree, once for the handoff file alone
- saves a small record for the session in Claude Code's storage for Torch (`~/.claude/plugins/store/torch_….json`): the handoff's path, its SHA-256 hash, the planned archive path and the time
- deletes records there that are more than 30 days old

**On each message**, Torch:

- looks up the session's record, and does nothing more without one
- on the session's first message, deletes the record and moves the handoff into `<project>/.claude/handoff-archive/` by running `mkdir -p`, `mv` (to a hidden name beside the handoff), `link` (into the archive) and `rm -f` (the hidden name)

**The skills** run only when you or Claude invoke them:

- **`/torch:save-handoff`**
  - runs `date -u`, `git rev-parse --show-toplevel`, `git branch --show-current`, `git rev-parse HEAD`, `git status --short`, `git log -1 --oneline`, `git diff --stat` and `git check-ignore`
  - writes `handoff-before-clear.md` at the project root
- **`/torch:load-handoff`**
  - runs `git rev-parse --show-toplevel`, `git branch --show-current`, `git rev-parse HEAD` and `git status --short`
  - reads the handoff, or else one Torch couldn't finish archiving or the newest archived one, plus the project's `CLAUDE.md` and the files the handoff lists
  - moves it to the archive if you choose that

See [PRIVACY.md](PRIVACY.md) for retention and contact details.

## Requirements

- **Claude Code 2.1.287 or later, with mods allowed.** Torch is tested with 2.1.292. An organization can turn off mods that users install; there, Torch's skills work but nothing loads by itself. Torch works on your project folder, so it is not for claude.ai chat or Cowork, and its skills say so and stop there.
- **macOS or Linux**, with `mkdir`, `mv`, `link` and `rm`, which both have. Windows is not supported. Nothing else to install: no Python, no Node.js.
- **git**, inside a git repository. Folders that aren't repositories work without git.

Keep handoffs out of commits. Add these three lines to each project's `.gitignore`; `/torch:save-handoff` warns when they're missing:

```
handoff-before-clear.md
.claude/handoff-archive/
.handoff-claim-*.md
```

## Install

Install Torch from Anthropic's plugin directory: in claude.ai under **Customize → Plugins**, or with `/plugin` in Claude Code. To try a copy of this repository without installing it, start Claude Code with `claude --plugin-dir /path/to/torch`.

## The handoff contract

`/torch:save-handoff` starts every handoff with a front-matter block, which Torch reads for the save time and git state:

```
---
handoff: 1
saved_at: 2026-10-06T14:54:32Z
branch: main
head: 91c8ecac1f0e3b2a9c7d4e5f60718293a4b5c6d7
---
# Handoff — <short title>
```

The values are raw command output:

- `saved_at` comes from `date -u +%Y-%m-%dT%H:%M:%SZ`.
- `branch` comes from `git branch --show-current`, or is `(detached)`.
- `head` comes from `git rev-parse HEAD`, or is `none`.

A handoff without a valid block still loads; the banner then says `no saved git state to compare`. [examples/handoff-before-clear.example.md](examples/handoff-before-clear.example.md) shows a complete handoff.

## Troubleshooting

- **No banner at session start:**
  - check that `handoff-before-clear.md` is at the project root and starts with a `# Handoff` title
  - a handoff saved more than 14 days ago, or one committed to the repository, gets a banner saying why it wasn't loaded
  - headless sessions never load it
  - run `claude --version` (2.1.287 or later), then `/plugin`: its tabs show `1 mod active · torch` when Torch's mod has loaded
- **"torch: could not load the handoff: …" or "could not archive the handoff: …":** start Claude Code with `claude --debug`, try again, and open an [issue](https://github.com/PetroczyP/torch/issues) with the line and the debug log.
- **The handoff was archived but the work didn't happen:** see example 3.

## Uninstall

Uninstall Torch with `/plugin` in Claude Code, or remove it on claude.ai. Torch's session records are in `~/.claude/plugins/store/torch_….json`; Claude Code deletes that file once no session has used it for `cleanupPeriodDays` (30 days by default), and you can delete it yourself at any time. Your handoff files and archives stay in your projects until you delete them.

## Support and security

Report problems and ask questions in [GitHub issues](https://github.com/PetroczyP/torch/issues). Report security vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
