---
name: load-handoff
description: In Claude Code, load a saved handoff by hand. Reads handoff-before-clear.md, or the newest archived handoff when there is none, checks git drift, and confirms the next step before resuming. Use only when the user asks to load or reload a handoff, or to recover an archived one. Torch loads the handoff by itself at session start, so an ordinary "continue" needs no skill. Needs Claude Code with the user's project folder; not for claude.ai chat.
---

This skill needs Claude Code working in the user's own project folder on their machine. If you are not in Claude Code with that folder (for example in claude.ai chat or a temporary sandbox), tell the user Torch needs Claude Code and stop.

If this session already received the handoff at session start (Torch's message says so) and the user only asks to continue, don't use this skill: continue from the handoff you have.

Resume the work described in `handoff-before-clear.md` without losing continuity.

## Locate and read the handoff

1. Determine the project root: `git rev-parse --show-toplevel`, else the current working directory.
2. Read `<project-root>/handoff-before-clear.md` from disk, even when this session's context already holds a handoff added at session start: another session may have saved a newer one since, and the file you resume must be the file you archive.
3. If the file is missing, look for the most recently modified `.md` file in `<project-root>/.claude/handoff-archive/`, and for a `<project-root>/.handoff-claim-*.md` file, which Torch leaves when it can't finish archiving a handoff. This covers a handoff that was archived although its work never happened, for example by a session closed right after its first message. If there is one, tell the user it comes from the archive and when it was saved, then continue with it below. If the archive is empty or missing too: tell the user "No handoff file found — nothing to resume." and stop.
4. If the file is empty or has no line starting with `# Handoff`: tell the user the file looks malformed, show the first 20 lines, and ask whether to proceed anyway.

## Sanity-check the handoff matches the current project

The handoff records the git state from when it was saved. Run these commands now and compare:

- `git branch --show-current` and `git rev-parse HEAD`, against the front matter's `branch` and `head` when the file starts with the contract block (`handoff: 1`). Empty output from `git branch --show-current` means a detached HEAD, written `(detached)` in the block; a value of `none` means it was not recorded. Without the block, use the branch and last commit shown under `Current state`.
- `git status --short`, against the snapshot under `Current state`, in every case.

Possible outcomes:

- **Branch mismatch** → warn the user clearly before resuming. They may be on the wrong branch, in a different worktree, or in the wrong repo entirely.
- **Significant git drift** (different files dirty, new commits since save) → summarize the drift in 2–3 lines and confirm the user still wants to resume the old plan as-written.
- **State matches cleanly** → proceed.

This reconciliation matters because handoffs are snapshots of a world that may have moved on (teammate pushed, user edited files externally, rebase happened).

## Refresh context

Read, in this order:

1. `CLAUDE.md` at the project root, if present — the project's standing instructions.
2. The files listed under `Relevant files` in the handoff — at minimum the ones the next step will touch.

## Confirm before executing

Summarize to the user:

- The goal
- What's already done (1–2 bullets)
- What the immediate next step is

Then ask: "Ready to continue from [brief description of next step]. Proceed?"

Do NOT start executing work automatically. The user may want to adjust the plan, re-prioritize, skip a step, or abandon the resume entirely. This pause is the whole point of the skill — it prevents a fresh session from charging off based on stale assumptions.

## After the user confirms

Once the user says go, ask one more short question: "Archive or keep the handoff file?" Skip it when the handoff came from the archive: it is already there.

- **Archive** → move the file to `<project-root>/.claude/handoff-archive/<ISO-timestamp>.md` (create the directory if needed). A later `/torch:load-handoff` then offers it only as an archived handoff, and only when there is no live one.
- **Keep** → leave the file in place (useful if the resume is tentative and might be repeated).

Default to recommending archive — most handoffs are single-use.
