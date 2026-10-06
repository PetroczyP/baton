#!/usr/bin/env python3
"""Torch's hook: load handoff-before-clear.md into a new Claude Code session.

One script, two hook entry points, run by hooks/session-start.sh and hooks/prompt-submit.sh:

  session-start   SessionStart, matcher "startup|clear". When the project root holds a
                  handoff-before-clear.md written in the last MAX_AGE_DAYS days, adds it
                  to Claude's context and shows a one-line banner with the git drift
                  since it was saved.
  prompt-submit   UserPromptSubmit. On the session's first prompt, moves the loaded
                  handoff to .claude/handoff-archive/ so the next session does not load
                  it again. A first prompt of /torch:load-handoff leaves the file to that
                  skill.

It reads the handoff contract (v1) that /torch:save-handoff writes: a front-matter block with
`handoff: 1`, `saved_at`, `branch` and `head`, then a `# Handoff` title. A file without a
valid block still loads, without the branch and HEAD comparison.

Interactive Claude Code sessions only: headless runs (`claude -p`, SDK) and Cowork are skipped,
so a review session or a Cowork task started in the project neither sees nor archives the handoff.

Exit codes: 0 when it did its job or had nothing to do; 1 when it could not run, which
Claude Code shows as a non-blocking hook error. Never 2: on UserPromptSubmit that would
block the user's prompt.

Needs Python 3.9+. Git is optional: outside a repo the drift check is skipped. Process
launches are the cost here, so a session without a handoff starts no git at all, and one
with a handoff runs two small `git status` calls side by side.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

HANDOFF_NAME = "handoff-before-clear.md"
ARCHIVE_DIR = Path(".claude") / "handoff-archive"
MAX_AGE_DAYS = 14             # older handoffs are announced, not loaded
CONTEXT_LIMIT = 9_800         # Claude Code caps additionalContext at 10,000 characters
MARKER_MAX_AGE_DAYS = 30      # markers of sessions that never sent a prompt
GIT_TIMEOUT_SECONDS = 5


def state_dir() -> Path:
    """Session records live in the plugin's data folder, which uninstalling the plugin removes."""
    data = os.environ.get("CLAUDE_PLUGIN_DATA")
    if not data:
        raise RuntimeError("CLAUDE_PLUGIN_DATA is not set; this hook runs as part of the torch plugin")
    return Path(data) / "sessions"


def marker_path(session_id: object) -> Optional[Path]:
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id):
        return None
    return state_dir() / f"{session_id}.json"


def emit(event: str, message: Optional[str] = None, context: Optional[str] = None) -> None:
    out: dict = {}
    if message:
        out["systemMessage"] = message
    if context:
        out["hookSpecificOutput"] = {"hookEventName": event, "additionalContext": context}
    if out:
        print(json.dumps(out))


def git_parallel(root: Path, *commands: tuple[str, ...]) -> list[Optional[str]]:
    """Run several git commands at once; each result is its stdout, or None on failure."""
    procs: list[Optional[subprocess.Popen]] = []
    for args in commands:
        try:
            procs.append(subprocess.Popen(["git", "-C", str(root), *args], text=True,
                                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL))
        except OSError:
            procs.append(None)
    deadline = time.monotonic() + GIT_TIMEOUT_SECONDS
    results: list[Optional[str]] = []
    for proc in procs:
        if proc is None:
            results.append(None)
            continue
        try:
            out, _ = proc.communicate(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            results.append(None)
            continue
        results.append(out if proc.returncode == 0 else None)
    return results


def project_root(cwd: Path) -> tuple[Path, bool]:
    """The enclosing work tree's top level (a .git directory or file), else cwd itself."""
    for folder in (cwd, *cwd.parents):
        if (folder / ".git").exists():
            return folder, True
    return cwd, False


def is_skipped_session() -> bool:
    """Headless runs and Cowork tasks: Torch serves interactive Claude Code sessions only."""
    if os.environ.get("CLAUDE_CODE_SESSION_ATTENDED") == "0":
        return True
    entrypoint = os.environ.get("CLAUDE_CODE_ENTRYPOINT", "")
    return entrypoint.startswith("sdk") or entrypoint == "local-agent"


def has_title(text: str) -> bool:
    return re.search(r"^# Handoff(\s.*)?$", text, re.M) is not None


CONTRACT_KEYS = {"handoff", "saved_at", "branch", "head"}


def contract_fields(text: str) -> Optional[dict]:
    """The contract's front matter, or None when it is missing or not exactly valid.

    Values are single-line command output taken literally; a quoted value, a missing or
    repeated key, or a value of the wrong shape makes the whole block count as absent.
    """
    lines = text.splitlines()
    if not lines or lines[0] != "---" or "---" not in lines[1:]:
        return None
    fields: dict = {}
    for line in lines[1:lines.index("---", 1)]:
        key, sep, value = line.partition(":")
        if not sep or key in fields:
            return None
        fields[key] = value.strip()
    if set(fields) != CONTRACT_KEYS or fields["handoff"] != "1":
        return None
    try:
        saved = datetime.strptime(fields["saved_at"], "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None
    if not (fields["head"] == "none" or re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", fields["head"])):
        return None
    if not re.fullmatch(r"[^\s\"'`]+", fields["branch"]):
        return None
    fields["saved_ts"] = saved.replace(tzinfo=timezone.utc).timestamp()
    return fields


def repo_status(root: Path) -> dict:
    """Branch, HEAD, uncommitted changes and whether the handoff is tracked.

    Two status calls run side by side. The first covers the work tree without the handoff
    and the archive folder, so archiving never counts as a change; when it fails, `tree` is
    False. The second looks at the handoff alone, with ignored files shown: an untracked
    handoff is listed as `?`, an ignored one as `!`, and a tracked one either with its change
    or, unmodified, not at all; when it fails, `handoff_tracked` is None. Asking about ignored
    files for the whole tree would walk every ignored folder.
    """
    tree, own = git_parallel(
        root,
        ("status", "--porcelain=v2", "--branch", "--untracked-files=normal", "--", ".",
         f":(exclude){HANDOFF_NAME}", f":(exclude){ARCHIVE_DIR.as_posix()}"),
        ("status", "--porcelain=v2", "--untracked-files=normal", "--ignored=traditional",
         "--", HANDOFF_NAME),
    )
    facts: dict = {"tree": tree is not None, "branch": None, "head": None, "changes": 0,
                   "handoff_tracked": None}
    if own is not None:
        facts["handoff_tracked"] = not any(line[:2] in ("? ", "! ") for line in own.splitlines())
    for line in (tree or "").splitlines():
        if line.startswith("# branch.head "):
            head = line[len("# branch.head "):]
            facts["branch"] = head
        elif line.startswith("# branch.oid "):
            oid = line[len("# branch.oid "):]
            facts["head"] = None if oid == "(initial)" else oid
        elif line[:2] in ("1 ", "2 ", "u ", "? "):
            facts["changes"] += 1
    return facts


def drift_parts(status: Optional[dict], is_repo: bool, fields: Optional[dict]) -> list[str]:
    if not is_repo:
        return ["not a git repo"]
    if status is None or not status["tree"]:
        return ["git state unavailable"]
    branch = status["branch"]
    saved_branch = fields["branch"] if fields and fields["branch"] != "none" else None
    saved_head = fields["head"] if fields and fields["head"] != "none" else None
    if saved_branch is None:
        parts = [f"branch {branch}"]
    elif saved_branch == branch:
        parts = [f"branch {branch} ✓"]
    else:
        parts = [f"⚠ branch {branch}, handoff was on {saved_branch}"]
    head = status["head"]
    if saved_head and head:
        parts.append("no new commits" if head == saved_head
                     else f"⚠ HEAD moved since the handoff ({saved_head[:7]} → {head[:7]})")
    elif fields is None:
        parts.append("no saved git state to compare")
    changes = status["changes"]
    parts.append("clean" if changes == 0
                 else f"{changes} uncommitted change{'s' if changes != 1 else ''}")
    return parts


def utf16_len(text: str) -> int:
    """Length as Claude Code counts it: JavaScript string length, in UTF-16 code units."""
    return len(text.encode("utf-16-le")) // 2


def human_age(seconds: float) -> str:
    minutes = max(0, int(seconds // 60))
    if minutes < 90:
        return f"{minutes} min"
    if minutes < 36 * 60:
        return f"{minutes // 60} h"
    return f"{minutes // (24 * 60)} d"


def free_archive_path(root: Path, saved_ts: float) -> Path:
    stamp = datetime.fromtimestamp(saved_ts, timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    folder = root / ARCHIVE_DIR
    candidate = folder / f"{stamp}.md"
    n = 2
    while candidate.exists():
        candidate = folder / f"{stamp}-{n}.md"
        n += 1
    return candidate


def remove_stale_markers() -> None:
    cutoff = time.time() - MARKER_MAX_AGE_DAYS * 86400
    for marker in state_dir().glob("*.json"):
        try:
            if marker.stat().st_mtime < cutoff:
                marker.unlink()
        except OSError:
            continue  # another session removed it, or it is unreadable; it is only a marker


def session_start(data: dict) -> int:
    if is_skipped_session() or data.get("source") not in ("startup", "clear"):
        return 0
    remove_stale_markers()
    root, is_repo = project_root(Path(data.get("cwd") or os.getcwd()))
    handoff = root / HANDOFF_NAME
    if handoff.is_symlink():
        emit("SessionStart", f"{HANDOFF_NAME} is a symbolic link, so it was not loaded or moved. "
                             "Run /torch:load-handoff to use it.")
        return 0
    if not handoff.is_file():
        return 0

    raw = handoff.read_bytes()
    text = raw.decode("utf-8", errors="replace")
    if not has_title(text):
        emit("SessionStart", f"{HANDOFF_NAME} has no '# Handoff' title, so it was not loaded. "
                             "Run /torch:load-handoff to look at it.")
        return 0
    fields = contract_fields(text)
    saved_ts = fields["saved_ts"] if fields else handoff.stat().st_mtime
    saved = datetime.fromtimestamp(saved_ts).astimezone().strftime("%Y-%m-%d %H:%M %Z")
    age = human_age(time.time() - saved_ts)
    if time.time() - saved_ts > MAX_AGE_DAYS * 86400:
        emit("SessionStart", f"A handoff from {saved} ({age} old) is here but was not loaded: it is "
                             f"older than {MAX_AGE_DAYS} days. Run /torch:load-handoff to use it.")
        return 0

    status = repo_status(root) if is_repo else None
    if status is not None and status["handoff_tracked"] is None:
        emit("SessionStart", f"Could not check with git whether {HANDOFF_NAME} is committed to this "
                             "repo, so it was not loaded. Run /torch:load-handoff if it is yours.")
        return 0
    if status is not None and status["handoff_tracked"]:
        emit("SessionStart", f"{HANDOFF_NAME} is committed to this repo, so it was not loaded. "
                             "Run /torch:load-handoff if it is yours.")
        return 0

    drift = drift_parts(status, is_repo, fields)
    archive_to = free_archive_path(root, saved_ts)
    marker = marker_path(data.get("session_id"))
    archived_later = False
    if marker is not None:
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(json.dumps({
                "handoff": str(handoff),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "archive_to": str(archive_to),
            }))
            archived_later = True
        except OSError as exc:
            print(f"handoff-autoload: could not record this session ({exc}); "
                  "the handoff stays in place", file=sys.stderr)

    if archived_later:
        where = (f"When the user's first message arrives it moves to {archive_to}, "
                 "unless that message is /torch:load-handoff, which then handles it.")
        tail = "Archived after your first message."
    else:
        where = "It stays in place: this session could not be recorded for archiving."
        tail = "It will not be archived automatically."

    header = (
        "A handoff from the previous session in this project was loaded automatically "
        "(torch plugin).\n\n"
        f"File: {handoff}, saved {saved}, {age} ago.\n"
        f"Git now, compared with the handoff: {'; '.join(drift)}.\n"
        f"{where}\n\n"
        "How to use it:\n"
        "- Wait for the user's first message. If it continues this work, pick up from the "
        "handoff without asking the user to confirm, and first mention any drift above in "
        "one line.\n"
        "- If the message is about something else, leave the handoff aside.\n"
        "- Claude wrote it for the user at the end of the last session; the user's messages "
        "take precedence over it.\n"
    )
    inline = f"{header}\n<handoff>\n{text.rstrip()}\n</handoff>"
    if utf16_len(inline) <= CONTEXT_LIMIT:
        context, size_note = inline, ""
    else:
        location = (f"It is at {handoff} until the user's first message, then at {archive_to}."
                    if archived_later else f"It is at {handoff}.")
        context = (f"{header}\nThe handoff is {len(text):,} characters, too long to include here. "
                   f"Read it before acting on it. {location}")
        size_note = f" · {len(text):,} chars, Claude reads it from the file"
    emit("SessionStart",
         f"Handoff loaded: saved {saved} ({age} ago) · {' · '.join(drift)}{size_note}. {tail}",
         context)
    return 0


def link_free(src: Path, dest: Path) -> Path:
    """Hard-link src at dest, or at dest-2, dest-3, ... when taken; never replaces a file."""
    stem, n = dest.stem, 2
    while True:
        try:
            os.link(src, dest)
            return dest
        except FileExistsError:
            dest = dest.with_name(f"{stem}-{n}.md")
            n += 1


def archive(handoff: Path, loaded_sha: str, dest: Path) -> tuple[str, Optional[Path]]:
    """Move the loaded handoff into the archive without losing or replacing any file.

    Renaming the live file to a private name claims it atomically. The claimed file is then
    hard-linked into place, back to the live path when it is not the handoff this session
    loaded, otherwise into the archive, and only its private name is removed afterwards.
    The file keeps its identity, so a save another session is still writing lands in it,
    and a link never replaces an existing file. Without hard links the claimed file stays
    under its private name in the archive folder: "kept" when it is the loaded handoff,
    "kept-other" when it is a later save, "kept-unread" when it could not be read to tell.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    claimed = dest.parent / f"claimed-{os.getpid()}-{time.time_ns()}.md"
    try:
        os.rename(handoff, claimed)
    except FileNotFoundError:
        return "gone", None
    matched: Optional[bool] = None
    try:
        matched = hashlib.sha256(claimed.read_bytes()).hexdigest() == loaded_sha
        if not matched:
            try:
                os.link(claimed, handoff)
                outcome, place = "changed", None
            except FileExistsError:      # an even newer save is live: keep this one archived
                outcome, place = "changed", link_free(claimed, dest)
        else:
            outcome, place = "archived", link_free(claimed, dest)
    except OSError:                      # no hard links on this filesystem
        return {True: "kept", False: "kept-other", None: "kept-unread"}[matched], claimed
    claimed.unlink()
    return outcome, place


def prompt_submit(data: dict) -> int:
    marker = marker_path(data.get("session_id"))
    if marker is None or not marker.is_file():
        return 0
    # Read, then delete the marker before acting: whatever happens next, this session
    # tries at most once, so a failure is reported once rather than on every prompt.
    try:
        info = json.loads(marker.read_text())
    finally:
        marker.unlink()
    if re.match(r"\s*/(?:torch:)?load-handoff(\s|$)", data.get("prompt") or ""):
        return 0
    outcome, dest = archive(Path(info["handoff"]), info["sha256"], Path(info["archive_to"]))
    if outcome == "archived":
        emit("UserPromptSubmit", f"Handoff archived to {dest}",
             f"The auto-loaded handoff is now archived at {dest}.")
    elif outcome == "changed":
        emit("UserPromptSubmit", f"{HANDOFF_NAME} changed after it was loaded, so it was left for "
                                 "the next session" + (f" (kept in {dest})." if dest else "."),
             f"Another session saved a newer handoff after this session loaded its own. The file at "
             f"{info['handoff']} is that newer handoff, not the one loaded at session start"
             + (f"; an intermediate save is kept at {dest}." if dest else "."))
    elif outcome == "kept":
        emit("UserPromptSubmit", f"Could not archive {HANDOFF_NAME}: this filesystem has no hard "
                                 f"links. It is kept at {dest}.",
             f"The auto-loaded handoff could not be archived and is now at {dest}.")
    elif outcome == "kept-other":
        emit("UserPromptSubmit", f"{HANDOFF_NAME} changed after it was loaded and could not be put "
                                 f"back: this filesystem has no hard links. The newer file is at {dest}.",
             f"A handoff saved after this session loaded its own is now at {dest}. It is not the "
             "handoff loaded at session start.")
    elif outcome == "kept-unread":
        emit("UserPromptSubmit", f"Could not archive {HANDOFF_NAME}: this filesystem has no hard "
                                 f"links and the file could not be read. It is kept at {dest}.",
             f"The handoff file is now at {dest}. It could not be read, so it is unknown whether "
             "it is the one loaded at session start.")
    return 0


def main(argv: list[str]) -> int:
    handlers = {"session-start": session_start, "prompt-submit": prompt_submit}
    if len(argv) != 2 or argv[1] not in handlers:
        print(f"usage: {Path(argv[0]).name} session-start|prompt-submit", file=sys.stderr)
        return 1
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            raise ValueError("hook input is not a JSON object")
        return handlers[argv[1]](data)
    except Exception as exc:  # report and stay non-blocking: exit 2 would block the prompt
        print(f"handoff-autoload {argv[1]} did not run: {type(exc).__name__}: {exc}",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
