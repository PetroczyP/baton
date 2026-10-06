---
name: save-handoff
description: In Claude Code, save the current session's state (goal, progress, files, git state, open decisions) to handoff-before-clear.md in the project so the next session can resume. Use when the user asks to save, wrap up, checkpoint or pause work, mentions /clear or /compact, or says context is running low. Needs Claude Code with the user's project folder; not for claude.ai chat.
---

This skill needs Claude Code working in the user's own project folder on their machine. If you are not in Claude Code with that folder (for example in claude.ai chat or a temporary sandbox), tell the user Torch needs Claude Code and stop.

Write a continuation handoff to `handoff-before-clear.md` at the project root so a fresh Claude session can pick up exactly where this one leaves off.

## Locate the project root

1. Run `git rev-parse --show-toplevel`. If it succeeds, that's the project root.
2. If the command fails (not in a git repo), fall back to the current working directory.
3. Write the handoff to `<project-root>/handoff-before-clear.md`.

## Collect ground-truth state before writing

Don't rely on memory for git state — run the commands and paste their output verbatim into the handoff. The fresh session needs the truth, not a paraphrase.

- `date -u +%Y-%m-%dT%H:%M:%SZ`
- `git branch --show-current`
- `git rev-parse HEAD`
- `git status --short`
- `git log -1 --oneline`
- `git diff --stat` (only if there are uncommitted changes)

## Overwrite, don't append

Always overwrite the file completely. The handoff represents the single current in-progress state; past handoffs aren't useful and cause confusion when load-handoff runs later.

## Required structure (handoff contract v1)

The file starts with this front-matter block, then the title. Tools read the block, so write
it exactly:

```
---
handoff: 1
saved_at: 2026-10-06T14:54:32Z
branch: main
head: 91c8ecac1f0e3b2a9c7d4e5f60718293a4b5c6d7
---
# Handoff — <short title>
```

1. The `---` line is the file's first line. The block has exactly these four keys, each once.
2. Each value is the command's single-line output as printed, with no quotes, backticks or
   comments: `saved_at` from `date -u +%Y-%m-%dT%H:%M:%SZ`, `branch` from
   `git branch --show-current`, `head` from `git rev-parse HEAD`.
3. When `git branch --show-current` prints nothing (detached HEAD), write `branch: (detached)`.
   When a git command fails (not a repo, no commits yet), write `none` for its key and never
   its error text.
4. The title is `# Handoff`, optionally followed by ` — <short title>`.

Then these sections, as `##` headings with exactly these names, in this order:

1. **Goal** — the overall task/objective in 1–2 sentences.
2. **Completed** — what's been done (file paths, specific changes, key decisions). Use absolute paths so the fresh session doesn't have to guess the working directory.
3. **Remaining** — what's still to do, in execution order.
4. **Key context** — discoveries, gotchas, decisions that would be lost without this doc. This is the most important section: it captures what the fresh session cannot rediscover easily from the code.
5. **Relevant files** — absolute file paths created/modified or needing attention.
6. **Current state** — paste the verbatim output of `git status --short`, `git log -1 --oneline` and, when there are changes, `git diff --stat`, plus any in-progress edits not yet saved to disk.
7. **Absolute don'ts** — hard constraints from the user that must carry forward (e.g., "don't push to main", "never mock the DB in these tests").

Write the file as a direct instruction to a fresh Claude session — phrased as "Continue the following task:" rather than a retrospective log.

## Length target

Aim for 400–800 words. Go up to roughly 1500 only if truly necessary. Leaner is better — the new session needs its context budget for the actual work, not for reading a long document.

## After writing

1. Check that git ignores both the handoff and its archive: run `git check-ignore -q handoff-before-clear.md` and `git check-ignore -q .claude/handoff-archive/x.md` from the project root (exit status 0 means ignored). For each one that is not ignored, tell the user so they can add it to `.gitignore` — handoffs, and the archived copies that Torch moves into `.claude/handoff-archive/`, may contain ticket IDs, internal decisions, credentials, or paths that shouldn't land in commits.
2. Confirm to the user: "Handoff saved to `handoff-before-clear.md`. The next session in this project, or this one after `/clear`, loads it automatically. (Use `/compact` instead if you only want to compress context without a full reset.)"
