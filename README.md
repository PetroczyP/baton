# Torch

Torch passes your work from one Claude Code session to the next. Run `/torch:save-handoff` before you stop. When you next start Claude Code in that project, or after `/clear`, a one-line banner shows that the handoff is there, when it was saved and what changed in git since. Your first message brings it to Claude and moves it into an archive, so the session after that starts fresh.

Without Torch you would type a load command, confirm it, and choose whether to archive the file, every time. With Torch you just start working.

## What you see

```
⏺ torch: Handoff ready: saved 2026-10-06 14:54 GMT+2 (3 h ago) · branch main ✓ · no new commits · clean. Claude gets it with your first message, which archives it.
```

When the project has moved on since the save, the banner says so, for example `⚠ branch main, handoff was on feature/x`, `⚠ HEAD moved since the handoff (91c8eca → 1a2b3c4)` or `2 uncommitted changes`. Claude mentions that drift before it continues. With your first message:

```
⏺ torch: Handoff archived to /path/to/project/.claude/handoff-archive/20261006T125432Z.md
```

## Examples

1. **End of the day.** Type `/torch:save-handoff`. Claude writes `handoff-before-clear.md` with the goal, what's done, what's next and the git state. Tomorrow, start `claude` in the project and type "continue". Claude picks up from the handoff, and mentions anything that changed in git overnight.
2. **Context is running low mid-task.** Type `/torch:save-handoff`, then `/clear`, then "continue". Your first message in the fresh context brings the handoff with it, and you carry on.
3. **You closed a session right after your first message.** That first message archived the handoff, but the work never happened. Type `/torch:load-handoff` in a new session. It offers the newest archived handoff, checks git drift and asks before resuming. Alternatively, `claude --continue` reopens the earlier session with the handoff still in its context.

## Try it

1. Start Claude Code with Torch installed, in any git repository, and ask for something small.
2. Type `/torch:save-handoff`. Claude writes `handoff-before-clear.md` at the project root.
3. Type `/exit`, then start `claude` again in the same folder. The banner says the handoff is ready.
4. Type "continue". The handoff reaches Claude with that message, Claude picks up from it, and the file moves to `.claude/handoff-archive/`.

To try it with the sample instead:

1. Copy [examples/handoff-before-clear.example.md](examples/handoff-before-clear.example.md) to a project root as `handoff-before-clear.md`.
2. Set its `saved_at` to the current time, the output of `date -u +%Y-%m-%dT%H:%M:%SZ`. A handoff saved more than 14 days ago is announced, not loaded.

## What Torch tells Claude

With your first message, Torch gives Claude the handoff's text and these instructions, as context attached to that message:

> - If this message continues the work in the handoff, pick up from it without asking the user to confirm, and first mention any drift above in one line.
> - If this message is about something else, leave the handoff aside.
> - The user's messages take precedence over the handoff.

They are preceded by:

- a line saying the handoff was loaded automatically with this message and that Torch does not check who wrote it
- the handoff's path, its save time, and where it is now: in the archive, or where it was kept when the move couldn't finish
- the git drift summary from session start

A handoff too large to include is replaced by its path and an instruction to read it before acting on it. If the file changed between session start and your first message, Claude gets no handoff, and both you and Claude are told what happened and where the file is. If it disappeared, you are told, and Claude gets nothing; the same goes when Torch was reloaded after announcing it (below).

## How it decides

1. **Only the newest handoff is loaded.** That's `handoff-before-clear.md` at the project root, the git top level or else the folder you started in. Each save overwrites it. The archive is never read automatically, and neither is another project's handoff.
2. **Only new sessions and `/clear` announce it, and only your first message delivers it.** Resumed and compacted sessions already have their context.
3. **Only interactive Claude Code on your machine loads it.** A headless run (`claude -p`, the Agent SDK), Cowork, a cloud or remote session, and other hosts never load it. Only the session that announced a handoff delivers and archives it, and only a message you send counts: a background task's notification or another session's message leaves the handoff for yours. Only the run of Torch that announced a handoff acts on it: if Torch is reloaded in between, as when an update to it is loaded mid-session, or Claude Code restarts and the session is resumed while its record is still there, your next message neither gives Claude the handoff nor moves it, says so, and leaves the file for `/torch:load-handoff`. Torch is tested in the terminal; the IDE extensions and the desktop app's Code tab run the same Claude Code, but Torch isn't tested there.
4. **Your first message archives it.** It moves to `.claude/handoff-archive/<saved-time>.md` as the message goes to Claude. It never overwrites an existing archive, and never deletes a handoff that another session saved in the meantime. If it can't finish the move, Torch tells you and Claude where the file is: in rare cases, a hidden `.handoff-claim-….md` file at the project root. If another hook refuses that first message, Claude doesn't get the handoff and Torch doesn't retry; `/torch:load-handoff` brings it back from the archive. Commands like `/clear`, `/exit`, `/model` and `/effort` don't count as messages, so a session you close without typing leaves the handoff for the next one.
5. **A first message of `/torch:load-handoff` leaves the file to that skill.**
6. **Old handoffs are announced, not loaded.** If a handoff was saved more than 14 days ago, the banner says it's there and it stays put. The save time comes from the handoff's `saved_at`, or the file's modification time without it.
7. **A handoff committed to the repository is not loaded.** Handoffs are meant to stay out of commits, so a tracked one may be someone else's or may have come with a clone. It also isn't loaded inside a git repository when git can't tell whether it is tracked. These checks do not prove who wrote a file; an untracked handoff from someone else can still load automatically.
8. **A large handoff is pointed to, not pasted.** Torch includes a handoff of up to about 10,000 characters, to keep the session's context lean. Above that, Claude is told where to read the file. A handoff over 4 MiB is not loaded at all.
9. **A file without a `# Handoff` title, or a symbolic link, is not loaded.** The banner says why.

## What Torch sends, reads, runs and writes

Torch is a Claude Code *mod*: JavaScript in [`hooks/torch.mjs`](hooks/torch.mjs) and [`hooks/rules.mjs`](hooks/rules.mjs) that runs inside Claude Code. It has no server, account or telemetry.

**What it sends, and where.** Torch makes no network requests of its own. With your first message it adds, as context for Claude:

- the handoff's text, or its path when it is too large to include
- the handoff's path, and where it was archived
- its save time
- the git drift summary

That context becomes part of your Claude Code conversation, which your Claude service processes like everything else you type.

**What it reads from your session.**

- At session start: the session id, the folder you started in, and whether the session is new or cleared.
- With each message: whether you sent it, or something else did, such as a background task's notification.
- With your first message: only whether its text starts with `/torch:load-handoff`.

Torch stores no message text and logs none. The record it keeps for a session (below) holds no handoff text either.

**What it runs, and why.** The mods API has no call to move a file, so Torch starts these programs. Each is named with its arguments, written as fixed text in the code except the file paths, and none runs through a shell. They run as you, outside Claude Code's sandbox, like any hook. They get fixed options, file paths and a working folder, never the handoff's text or anything from your conversation, whether as arguments or on standard input. None of them uses the network: `git status` reads only your local repository.

| When | Command, as run | Why |
| - | - | - |
| Session start, in a git repository | `git status --porcelain=v2 --branch --untracked-files=normal -- . ':(exclude)handoff-before-clear.md' ':(exclude).handoff-claim-*.md' ':(exclude).claude/handoff-archive'`, in the project folder | Shows what changed in git since the save: branch, commit and uncommitted changes, leaving Torch's own files out |
| Session start, in a git repository | `git status --porcelain=v2 --untracked-files=normal --ignored=traditional -- handoff-before-clear.md`, in the project folder | Tells whether the handoff is committed to the repository, which Torch refuses to load |
| First message | `mkdir -p -- .claude/handoff-archive`, in the project folder | Creates the archive folder the first time |
| First message | `mv -- <handoff> <claim>` | Claims the handoff in one atomic step, by renaming it to a hidden name beside it, so a save from another session can't be lost |
| First message | `link <claim> <archive or handoff>` | Places it in the archive, or gives a newer save back, without ever replacing an existing file |
| First message | `rm -f -- <claim>` | Removes the hidden name once the file is safely in place |

`<handoff>` is `handoff-before-clear.md` at the project root; `<claim>` is `.handoff-claim-<random>.md` beside it; `<archive or handoff>` is `.claude/handoff-archive/<saved-time>.md`, or the handoff's own path. All are full paths.

**What it writes.**

- At session start, a small record for the session in Claude Code's storage for Torch (`~/.claude/plugins/store/torch_….json`): the handoff's path, its SHA-256 hash, the planned archive path, its save time, the git drift summary, the time of the record and a random id for the run of Torch that wrote it, under the session id. Each session start where Torch runs also tries to delete any record there that is more than 30 days old.
- With the first message you send, it tries to delete the session's record and, once it is gone, moves the handoff into `<project>/.claude/handoff-archive/` with the commands above. Only the run of Torch that wrote a record acts on it; another run only tries to delete it.
- If the store refuses a deletion, the record stays and nothing is moved; the cleanup at a later session start tries again once the record is more than 30 days old.

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
- **"torch: could not announce the handoff: …" or "could not deliver the handoff: …":** start Claude Code with `claude --debug`, try again, and open an [issue](https://github.com/PetroczyP/torch/issues) with the line and the debug log.
- **The handoff was archived but the work didn't happen:** see example 3.

## Uninstall

Uninstall Torch with `/plugin` in Claude Code, or remove it on claude.ai. Torch's session records are in `~/.claude/plugins/store/torch_….json`; Claude Code deletes that file once no session has used it for `cleanupPeriodDays` (30 days by default), and you can delete it yourself at any time. Your handoff files and archives stay in your projects until you delete them.

## Support and security

Report problems and ask questions in [GitHub issues](https://github.com/PetroczyP/torch/issues). Report security vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
