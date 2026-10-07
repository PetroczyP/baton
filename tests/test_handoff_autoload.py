"""Tests for Torch's hook, hooks/handoff-autoload.py.

Each test runs the hook the way Claude Code does: a separate process, hook input as JSON
on stdin, the result read from stdout and the exit code. HOME points at a throwaway
directory, so the session markers never touch the real ~/.claude.

Run:  python3 tests/test_handoff_autoload.py      (or: python3 -m pytest tests/ -q)
"""
from __future__ import annotations

import contextlib
import errno
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / "hooks" / "handoff-autoload.py"
SESSION = "11111111-2222-3333-4444-555555555555"
GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
           "GIT_CONFIG_NOSYSTEM": "1"}


def iso(days_ago: float = 0) -> str:
    moment = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def handoff_text(branch: str = "main", head: str = "none", body: str = "Ship the widget.",
                 saved_at: str | None = None, front: str | None = None) -> str:
    """A handoff in the contract's shape; `front` replaces the whole front-matter block."""
    if front is None:
        front = (f"---\nhandoff: 1\nsaved_at: {saved_at or iso()}\nbranch: {branch}\n"
                 f"head: {head}\n---\n")
    return (
        f"{front}# Handoff — test\n\nContinue the following task.\n\n"
        f"## Goal\n\n{body}\n\n"
        "## Current state\n\n```\n$ git status --short\n(clean)\n```\n\n"
        "## Absolute don'ts\n\n- Never push.\n"
    )


class HookCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name).resolve()
        self.home = base / "home"
        self.home.mkdir()
        self.data = base / "plugin data"     # CLAUDE_PLUGIN_DATA; the space tests quoting
        self.repo = base / "repo"
        self.repo.mkdir()
        # A hermetic environment: only PATH comes from the caller, to find git and sh.
        self.env = dict(GIT_ENV, PATH=os.environ.get("PATH", "/usr/bin:/bin"), HOME=str(self.home),
                        CLAUDE_PLUGIN_DATA=str(self.data), CLAUDE_CODE_ENTRYPOINT="cli",
                        CLAUDE_CODE_SESSION_ATTENDED="1")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # -- helpers -------------------------------------------------------------------
    def git(self, *args: str, cwd: Path | None = None) -> str:
        done = subprocess.run(["git", *args], cwd=cwd or self.repo, env=self.env,
                              capture_output=True, text=True, check=True)
        return done.stdout.strip()

    def init_repo(self, branch: str = "main") -> str:
        self.git("init", "-q", "-b", branch)
        self.git("commit", "-q", "--allow-empty", "-m", "init")
        return self.git("rev-parse", "HEAD")

    def write_handoff(self, text: str, root: Path | None = None, age_days: float = 0) -> Path:
        path = (root or self.repo) / "handoff-before-clear.md"
        path.write_text(text, encoding="utf-8")
        if age_days:
            stamp = time.time() - age_days * 86400
            os.utime(path, (stamp, stamp))
        return path

    def run_hook(self, mode: str, payload: object, env: dict | None = None):
        stdin = payload if isinstance(payload, str) else json.dumps(payload)
        done = subprocess.run([sys.executable, str(HOOK), mode], input=stdin,
                              capture_output=True, text=True, env=env or self.env, timeout=60)
        out = json.loads(done.stdout) if done.stdout.strip() else {}
        return done.returncode, out, done.stderr

    def start(self, source: str = "startup", cwd: Path | None = None,
              session: str = SESSION, env: dict | None = None):
        return self.run_hook("session-start", {
            "session_id": session, "cwd": str(cwd or self.repo),
            "hook_event_name": "SessionStart", "source": source}, env)

    def prompt(self, text: str = "carry on", session: str = SESSION):
        return self.run_hook("prompt-submit", {
            "session_id": session, "cwd": str(self.repo),
            "hook_event_name": "UserPromptSubmit", "prompt": text})

    @staticmethod
    def context(out: dict) -> str:
        return out.get("hookSpecificOutput", {}).get("additionalContext", "")

    def archived(self) -> list[Path]:
        folder = self.repo / ".claude" / "handoff-archive"
        return sorted(folder.glob("*.md")) if folder.is_dir() else []


class SessionStartTests(HookCase):
    def test_no_handoff_prints_nothing(self):
        self.init_repo()
        code, out, _ = self.start()
        self.assertEqual((code, out), (0, {}))

    def test_handoff_is_added_to_context_with_a_banner(self):
        sha = self.init_repo()
        self.write_handoff(handoff_text("main", sha, body="Ship the purple widget."))
        code, out, _ = self.start()
        self.assertEqual(code, 0)
        self.assertIn("Ship the purple widget.", self.context(out))
        self.assertIn("Never push.", self.context(out))
        banner = out["systemMessage"]
        self.assertTrue(banner.startswith("Handoff loaded: saved "), banner)
        for part in ("branch main ✓", "no new commits", "clean", "Archived after your first message"):
            self.assertIn(part, banner)

    def test_headless_sessions_are_skipped(self):
        sha = self.init_repo()
        self.write_handoff(handoff_text("main", sha))
        unattended = dict(self.env, CLAUDE_CODE_SESSION_ATTENDED="0")
        sdk = {k: v for k, v in self.env.items() if k != "CLAUDE_CODE_SESSION_ATTENDED"}
        sdk["CLAUDE_CODE_ENTRYPOINT"] = "sdk-cli"
        cowork = dict(self.env, CLAUDE_CODE_ENTRYPOINT="local-agent", CLAUDE_CODE_SESSION_ATTENDED="1")
        for env in (unattended, sdk, cowork):
            self.assertEqual(self.start(env=env)[:2], (0, {}))
        self.assertEqual(self.prompt()[:2], (0, {}))
        self.assertTrue((self.repo / "handoff-before-clear.md").exists())

    def test_resumed_and_compacted_sessions_are_skipped(self):
        sha = self.init_repo()
        self.write_handoff(handoff_text("main", sha))
        for source in ("resume", "compact"):
            self.assertEqual(self.start(source=source)[:2], (0, {}))

    def test_clear_loads_like_a_new_session(self):
        sha = self.init_repo()
        self.write_handoff(handoff_text("main", sha, body="After clear."))
        _, out, _ = self.start(source="clear")
        self.assertIn("After clear.", self.context(out))

    def test_handoff_at_the_repo_root_is_found_from_a_subdirectory(self):
        sha = self.init_repo()
        sub = self.repo / "src" / "deep"
        sub.mkdir(parents=True)
        self.write_handoff(handoff_text("main", sha, body="Found from below."))
        _, out, _ = self.start(cwd=sub)
        self.assertIn("Found from below.", self.context(out))

    def test_drift_since_the_handoff_is_reported(self):
        old = self.init_repo()
        self.write_handoff(handoff_text("feature/x", old))
        self.git("commit", "-q", "--allow-empty", "-m", "two")
        new = self.git("rev-parse", "HEAD")
        (self.repo / "notes.txt").write_text("wip")
        _, out, _ = self.start()
        for part in ("⚠ branch main, handoff was on feature/x",
                     f"⚠ HEAD moved since the handoff ({old[:7]} → {new[:7]})", "1 uncommitted change"):
            self.assertIn(part, out["systemMessage"])
            self.assertIn(part, self.context(out))

    def test_the_handoff_and_its_archive_are_not_uncommitted_changes(self):
        sha = self.init_repo()
        archive = self.repo / ".claude" / "handoff-archive"
        archive.mkdir(parents=True)
        (archive / "20260101T000000Z.md").write_text("# Handoff\nold\n")
        self.write_handoff(handoff_text("main", sha))
        _, out, _ = self.start()
        self.assertIn("clean", out["systemMessage"])

    def test_a_handoff_without_the_contract_loads_without_a_comparison(self):
        self.init_repo()
        self.write_handoff("# Handoff — written before the contract\n\nOld-style plan.\n")
        _, out, _ = self.start()
        self.assertIn("Old-style plan.", self.context(out))
        self.assertIn("branch main · no saved git state to compare · clean", out["systemMessage"])

    def test_front_matter_that_breaks_the_contract_counts_as_absent(self):
        sha = self.init_repo()
        good = {"handoff": "1", "saved_at": iso(), "branch": "main", "head": sha}
        broken = [
            dict(good, branch='"main"'),
            dict(good, head=sha[:7]),
            dict(good, saved_at="2026-13-01T00:00:00Z"),
            dict(good, handoff="2"),
            {k: v for k, v in good.items() if k != "head"},
        ]
        for fields in broken + ["duplicate"]:
            if fields == "duplicate":
                front = f"---\nhandoff: 1\nhandoff: 1\nsaved_at: {iso()}\nbranch: main\nhead: {sha}\n---\n"
            else:
                front = "---\n" + "".join(f"{k}: {v}\n" for k, v in fields.items()) + "---\n"
            self.write_handoff(handoff_text(front=front))
            _, out, _ = self.start()
            self.assertIn("no saved git state to compare", out["systemMessage"], front)

    def test_a_detached_head_matches_the_contract_spelling(self):
        sha = self.init_repo()
        self.git("checkout", "-q", "--detach")
        self.write_handoff(handoff_text("(detached)", sha))
        _, out, _ = self.start()
        self.assertIn("branch (detached) ✓ · no new commits", out["systemMessage"])

    def test_head_none_skips_the_commit_comparison(self):
        self.init_repo()
        self.write_handoff(handoff_text("main", "none"))
        _, out, _ = self.start()
        self.assertIn("branch main ✓ · clean", out["systemMessage"])

    def test_saved_at_decides_age_and_archive_name_not_the_file_time(self):
        sha = self.init_repo()
        self.write_handoff(handoff_text("main", sha, body="Copied today.", saved_at=iso(20)))
        _, out, _ = self.start()
        self.assertIn("older than 14 days", out["systemMessage"])
        saved = iso(2)
        self.write_handoff(handoff_text("main", sha, saved_at=saved))
        _, out, _ = self.start()
        stamp = saved.replace("-", "").replace(":", "")
        self.assertIn(f".claude/handoff-archive/{stamp}.md", self.context(out))

    def test_a_gitignored_handoff_is_loaded(self):
        self.init_repo()
        (self.repo / ".gitignore").write_text("handoff-before-clear.md\n")
        self.git("add", ".gitignore")
        self.git("commit", "-q", "-m", "ignore")
        self.write_handoff(handoff_text("main", self.git("rev-parse", "HEAD"),
                                        body="Ignored but mine."))
        _, out, _ = self.start()
        self.assertIn("Ignored but mine.", self.context(out))
        self.assertIn("clean", out["systemMessage"])

    def test_a_repo_that_hides_untracked_files_still_loads(self):
        sha = self.init_repo()
        self.git("config", "status.showUntrackedFiles", "no")
        self.write_handoff(handoff_text("main", sha, body="Config does not hide me."))
        _, out, _ = self.start()
        self.assertIn("Config does not hide me.", self.context(out))

    def test_a_worktree_is_its_own_project_root(self):
        self.init_repo()
        tree = self.repo.parent / "tree"
        self.git("worktree", "add", "-q", "-b", "side", str(tree))
        self.write_handoff(handoff_text("side", self.git("rev-parse", "HEAD"),
                                        body="In the worktree."), root=tree)
        _, out, _ = self.start(cwd=tree)
        self.assertIn("In the worktree.", self.context(out))
        self.assertIn("branch side ✓", out["systemMessage"])

    def fake_git(self, fail_when: str) -> dict:
        """PATH with a git that fails when its arguments contain `fail_when`."""
        real = subprocess.run(["/bin/sh", "-c", "command -v git"], env=self.env,
                              capture_output=True, text=True, check=True).stdout.strip()
        folder = self.home / "fakebin"
        folder.mkdir(exist_ok=True)
        script = folder / "git"
        script.write_text(f'#!/bin/sh\ncase "$*" in *{fail_when}*) exit 128;; esac\nexec "{real}" "$@"\n')
        script.chmod(0o755)
        return dict(self.env, PATH=f"{folder}:{self.env['PATH']}")

    def test_a_repo_handoff_is_not_loaded_when_git_cannot_say_if_it_is_committed(self):
        sha = self.init_repo()
        self.write_handoff(handoff_text("main", sha, body="Unverifiable."))
        for env in (dict(self.env, PATH=str(self.home)), self.fake_git("--ignored")):
            _, out, _ = self.start(env=env)
            self.assertIn("Could not check with git", out["systemMessage"])
            self.assertNotIn("Unverifiable.", json.dumps(out))

    def test_a_committed_handoff_is_caught_even_when_the_tree_status_fails(self):
        self.init_repo()
        self.write_handoff(handoff_text(body="Committed plan."))
        self.git("add", "handoff-before-clear.md")
        self.git("commit", "-q", "-m", "oops")
        _, out, _ = self.start(env=self.fake_git("--branch"))
        self.assertIn("is committed to this repo", out["systemMessage"])
        self.assertNotIn("Committed plan.", json.dumps(out))

    def test_drift_reads_unavailable_when_only_the_tree_status_fails(self):
        sha = self.init_repo()
        self.write_handoff(handoff_text("main", sha, body="Still mine."))
        _, out, _ = self.start(env=self.fake_git("--branch"))
        self.assertIn("Still mine.", self.context(out))
        self.assertIn("git state unavailable", out["systemMessage"])

    def test_handoff_without_its_title_is_not_loaded(self):
        self.init_repo()
        self.write_handoff("# Handoffs and other notes\njust some notes\n")
        code, out, _ = self.start()
        self.assertEqual(code, 0)
        self.assertIn("no '# Handoff' title", out["systemMessage"])
        self.assertEqual(self.context(out), "")
        self.assertEqual(self.prompt()[:2], (0, {}))
        self.assertTrue((self.repo / "handoff-before-clear.md").exists())

    def test_a_symlinked_handoff_is_announced_and_left_alone(self):
        self.init_repo()
        (self.repo / "real.md").write_text(handoff_text(body="Behind a link."))
        link = self.repo / "handoff-before-clear.md"
        link.symlink_to("real.md")
        _, out, _ = self.start()
        self.assertIn("is a symbolic link", out["systemMessage"])
        self.assertNotIn("Behind a link.", json.dumps(out))
        self.assertEqual(self.prompt()[:2], (0, {}))
        self.assertTrue(link.is_symlink())
        self.assertEqual(self.archived(), [])

    def test_committed_handoff_is_not_loaded(self):
        self.init_repo()
        self.write_handoff(handoff_text(body="Someone else's plan."))
        self.git("add", "handoff-before-clear.md")
        self.git("commit", "-q", "-m", "oops")
        _, out, _ = self.start()
        self.assertIn("is committed to this repo", out["systemMessage"])
        self.assertNotIn("Someone else's plan.", json.dumps(out))

    def test_old_handoff_is_announced_but_not_loaded_or_archived(self):
        sha = self.init_repo()
        self.write_handoff(handoff_text("main", sha, body="Stale plan.", saved_at=iso(15)))
        _, out, _ = self.start()
        self.assertIn("older than 14 days", out["systemMessage"])
        self.assertEqual(self.context(out), "")
        self.prompt()
        self.assertTrue((self.repo / "handoff-before-clear.md").exists())

    def test_handoff_just_inside_the_age_limit_is_loaded(self):
        sha = self.init_repo()
        self.write_handoff(handoff_text("main", sha, body="Recent enough.", saved_at=iso(13.9)))
        _, out, _ = self.start()
        self.assertIn("Recent enough.", self.context(out))

    def test_large_handoff_is_pointed_to_not_inlined(self):
        sha = self.init_repo()
        big = handoff_text("main", sha, body="UNIQUE-BODY " + "x" * 12_000)
        path = self.write_handoff(big)
        _, out, _ = self.start()
        ctx = self.context(out)
        self.assertNotIn("UNIQUE-BODY", ctx)
        self.assertIn(str(path), ctx)
        self.assertIn(".claude/handoff-archive/", ctx)
        self.assertLessEqual(len(ctx.encode("utf-16-le")) // 2, 10_000)
        self.assertIn("Claude reads it from the file", out["systemMessage"])

    def test_inline_limit_counts_characters_the_way_claude_code_does(self):
        sha = self.init_repo()
        # Each emoji is 1 Python character but 2 UTF-16 units, Claude Code's measure.
        text = handoff_text("main", sha, body="\U0001F680" * 5_200)
        self.assertLess(len(text), 9_000)
        self.write_handoff(text)
        _, out, _ = self.start()
        ctx = self.context(out)
        self.assertNotIn("\U0001F680\U0001F680", ctx)
        self.assertLessEqual(len(ctx.encode("utf-16-le")) // 2, 10_000)

    def test_outside_a_git_repo_the_handoff_still_loads(self):
        self.write_handoff(handoff_text(body="No repo here."))
        _, out, _ = self.start()
        self.assertIn("No repo here.", self.context(out))
        self.assertIn("not a git repo", out["systemMessage"])

    def test_session_without_a_usable_id_loads_but_keeps_the_file(self):
        sha = self.init_repo()
        self.write_handoff(handoff_text("main", sha, body="Odd session id."))
        _, out, _ = self.start(session="../escape")
        self.assertIn("Odd session id.", self.context(out))
        self.assertIn("will not be archived automatically", out["systemMessage"])

    def test_markers_of_sessions_that_never_prompted_expire(self):
        state = self.data / "sessions"
        state.mkdir(parents=True)
        stale, fresh = state / "old-session.json", state / "new-session.json"
        for marker in (stale, fresh):
            marker.write_text("{}")
        month_ago = time.time() - 31 * 86400
        os.utime(stale, (month_ago, month_ago))
        self.init_repo()
        self.start()
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())


class PromptSubmitTests(HookCase):
    def load(self, body: str = "Ship the widget.") -> tuple[Path, str]:
        sha = self.init_repo()
        path = self.write_handoff(handoff_text("main", sha, body=body))
        _, out, _ = self.start()
        return path, self.context(out)

    def test_first_prompt_archives_the_loaded_handoff(self):
        path, ctx = self.load()
        original = path.read_bytes()
        code, out, _ = self.prompt("/goal ship it")
        self.assertEqual(code, 0)
        self.assertFalse(path.exists())
        [archived] = self.archived()
        self.assertEqual(archived.read_bytes(), original)
        self.assertIn(str(archived), ctx)
        self.assertEqual(out["systemMessage"], f"Handoff archived to {archived}")

    def test_later_prompts_do_nothing(self):
        self.load()
        self.prompt()
        self.assertEqual(self.prompt("next")[:2], (0, {}))
        self.assertEqual(len(self.archived()), 1)

    def test_load_handoff_as_first_prompt_leaves_the_file_to_the_skill(self):
        for command in ("/torch:load-handoff", "/load-handoff"):
            with self.subTest(command=command):
                self.tearDown()
                self.setUp()
                path, _ = self.load()
                self.assertEqual(self.prompt(command)[:2], (0, {}))
                self.assertTrue(path.exists())
                self.prompt("now continue")
                self.assertTrue(path.exists())
                self.assertEqual(self.archived(), [])

    def test_another_plugins_load_handoff_command_does_not_hold_the_file(self):
        path, _ = self.load()
        self.prompt("/someone-else:load-handoff")
        self.assertFalse(path.exists())
        self.assertEqual(len(self.archived()), 1)

    def test_a_handoff_saved_again_since_loading_is_kept_for_the_next_session(self):
        path, _ = self.load()
        path.write_text(handoff_text(body="A newer plan."))
        newer, newer_bytes = path.stat().st_ino, path.read_bytes()
        _, out, _ = self.prompt()
        self.assertEqual(path.stat().st_ino, newer, "the newer save must be left untouched")
        self.assertEqual(path.read_bytes(), newer_bytes)
        self.assertIn("changed after it was loaded", out["systemMessage"])
        self.assertIn(f"The file at {path} is that newer handoff, not the one loaded at session start",
                      self.context(out))
        self.assertEqual(self.archived(), [])

    def test_a_handoff_removed_since_loading_is_ignored(self):
        path, _ = self.load()
        path.unlink()
        self.assertEqual(self.prompt()[:2], (0, {}))

    def test_a_prompt_in_a_session_that_loaded_nothing_touches_nothing(self):
        sha = self.init_repo()
        path = self.write_handoff(handoff_text("main", sha))
        self.assertEqual(self.prompt()[:2], (0, {}))
        self.assertTrue(path.exists())

    def test_an_existing_archive_is_never_overwritten(self):
        path, ctx = self.load()
        announced = Path(ctx.split("it moves to ")[1].split(",")[0])
        announced.parent.mkdir(parents=True, exist_ok=True)
        announced.write_text("earlier archive")
        _, out, _ = self.prompt()
        self.assertEqual(announced.read_text(), "earlier archive")
        self.assertFalse(path.exists())
        self.assertEqual(len(self.archived()), 2)
        self.assertIn("-2.md", out["systemMessage"])

    def test_a_corrupt_session_record_is_reported_once(self):
        path, _ = self.load()
        marker = self.data / "sessions" / f"{SESSION}.json"
        marker.write_text("not json")
        code, _, err = self.prompt()
        self.assertEqual(code, 1)
        self.assertIn("did not run", err)
        self.assertEqual(self.prompt()[:2], (0, {}))
        self.assertTrue(path.exists())

    def test_the_next_session_after_archiving_loads_nothing(self):
        self.load()
        self.prompt()
        self.assertEqual(self.start(session="99999999-0000-0000-0000-000000000000")[:2], (0, {}))


def load_hook_module():
    spec = importlib.util.spec_from_file_location("handoff_autoload", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ArchiveRaceTests(HookCase):
    """A handoff saved by another session while this one archives must never be lost."""

    def setUp(self) -> None:
        super().setUp()
        self.hook = load_hook_module()
        self.live = self.repo / "handoff-before-clear.md"
        self.dest = self.repo / ".claude" / "handoff-archive" / "20260101T000000Z.md"
        self.loaded = b"# Handoff\nthe one this session loaded\n"

    def test_a_save_landing_before_the_claim_is_given_back(self):
        self.live.write_bytes(b"# Handoff\nnewer\n")
        outcome, kept = self.hook.archive(self.live, hashlib.sha256(self.loaded).hexdigest(), self.dest)
        self.assertEqual((outcome, kept), ("changed", None))
        self.assertEqual(self.live.read_bytes(), b"# Handoff\nnewer\n")
        self.assertEqual(list(self.dest.parent.iterdir()), [])

    def test_a_save_landing_right_after_the_claim_stays_live(self):
        self.live.write_bytes(b"# Handoff\nintermediate\n")
        real_rename = self.hook.os.rename

        def rename_then_save(src, dst):
            real_rename(src, dst)
            self.live.write_bytes(b"# Handoff\nnewest\n")

        self.hook.os.rename = rename_then_save
        try:
            outcome, kept = self.hook.archive(self.live, hashlib.sha256(self.loaded).hexdigest(), self.dest)
        finally:
            self.hook.os.rename = real_rename
        self.assertEqual(outcome, "changed")
        self.assertEqual(self.live.read_bytes(), b"# Handoff\nnewest\n")
        self.assertEqual(kept.read_bytes(), b"# Handoff\nintermediate\n")
        self.assertEqual([p.name for p in self.dest.parent.iterdir()], [kept.name])

    def test_a_save_still_being_written_lands_in_the_live_file(self):
        self.live.write_bytes(self.loaded)
        writer = open(self.live, "r+b")      # another session has opened and truncated it
        writer.truncate(0)
        try:
            outcome, _ = self.hook.archive(self.live, hashlib.sha256(self.loaded).hexdigest(), self.dest)
            writer.write(b"# Handoff\nthe new save\n")
        finally:
            writer.close()
        self.assertEqual(outcome, "changed")
        self.assertEqual(self.live.read_bytes(), b"# Handoff\nthe new save\n")

    def test_without_hard_links_the_claimed_handoff_is_kept(self):
        self.live.write_bytes(self.loaded)
        real_link = self.hook.os.link

        def no_links(src, dst):
            raise OSError(errno.EPERM, "hard links not supported")

        self.hook.os.link = no_links
        try:
            outcome, kept = self.hook.archive(self.live, hashlib.sha256(self.loaded).hexdigest(), self.dest)
        finally:
            self.hook.os.link = real_link
        self.assertEqual(outcome, "kept")
        self.assertEqual(kept.read_bytes(), self.loaded)
        self.assertEqual(kept.parent, self.dest.parent)

    def submit_without_hard_links(self) -> tuple[Path, str]:
        state = self.data / "sessions"
        state.mkdir(parents=True)
        (state / f"{SESSION}.json").write_text(json.dumps({
            "handoff": str(self.live), "sha256": hashlib.sha256(self.loaded).hexdigest(),
            "archive_to": str(self.dest)}))
        real_link, out = self.hook.os.link, io.StringIO()

        def no_links(src, dst):
            raise OSError(errno.EPERM, "hard links not supported")

        self.hook.os.link = no_links
        previous = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = str(self.data)
        try:
            with contextlib.redirect_stdout(out):
                self.hook.prompt_submit({"session_id": SESSION, "prompt": "go"})
        finally:
            self.hook.os.link = real_link
            if previous is None:
                os.environ.pop("CLAUDE_PLUGIN_DATA", None)
            else:
                os.environ["CLAUDE_PLUGIN_DATA"] = previous
        [kept] = list(self.dest.parent.iterdir())
        result = json.loads(out.getvalue())
        self.assertIn(str(kept), result["systemMessage"])
        return kept, result["hookSpecificOutput"]["additionalContext"]

    def test_without_hard_links_the_model_is_told_where_the_handoff_is(self):
        self.live.write_bytes(self.loaded)
        kept, context = self.submit_without_hard_links()
        self.assertIn(f"The auto-loaded handoff could not be archived and is now at {kept}", context)

    def test_without_hard_links_an_unreadable_handoff_is_not_identified(self):
        self.live.write_bytes(self.loaded)
        real_read = self.hook.Path.read_bytes

        def unreadable_claim(path):
            if path.name.startswith("claimed-"):
                raise PermissionError(errno.EACCES, "permission denied")
            return real_read(path)

        self.hook.Path.read_bytes = unreadable_claim
        try:
            kept, context = self.submit_without_hard_links()
        finally:
            self.hook.Path.read_bytes = real_read
        self.assertEqual(kept.read_bytes(), self.loaded)
        self.assertIn("it is unknown whether it is the one loaded", context)
        self.assertNotIn("It is not the handoff loaded", context)
        self.assertNotIn("The auto-loaded handoff", context)

    def test_without_hard_links_a_later_save_is_not_passed_off_as_the_loaded_one(self):
        self.live.write_bytes(b"# Handoff\nsaved by another session\n")
        kept, context = self.submit_without_hard_links()
        self.assertEqual(kept.read_bytes(), b"# Handoff\nsaved by another session\n")
        self.assertIn("It is not the handoff loaded at session start", context)
        self.assertNotIn("The auto-loaded handoff", context)

    def test_the_loaded_handoff_is_archived_and_nothing_else_remains(self):
        self.live.write_bytes(self.loaded)
        outcome, final = self.hook.archive(self.live, hashlib.sha256(self.loaded).hexdigest(), self.dest)
        self.assertEqual((outcome, final), ("archived", self.dest))
        self.assertFalse(self.live.exists())
        self.assertEqual([p.name for p in self.dest.parent.iterdir()], [self.dest.name])


class EntryPointTests(HookCase):
    def test_without_the_plugin_data_folder_it_says_so_and_never_blocks(self):
        sha = self.init_repo()
        self.write_handoff(handoff_text("main", sha))
        env = {k: v for k, v in self.env.items() if k != "CLAUDE_PLUGIN_DATA"}
        for mode in ("session-start", "prompt-submit"):
            payload = {"session_id": SESSION, "cwd": str(self.repo), "source": "startup", "prompt": "go"}
            code, _, err = self.run_hook(mode, payload, env)
            self.assertEqual(code, 1, mode)
            self.assertIn("CLAUDE_PLUGIN_DATA is not set", err)

    def test_unreadable_input_is_a_visible_non_blocking_error(self):
        for mode in ("session-start", "prompt-submit"):
            for payload in ("not json", "[]"):
                code, _, err = self.run_hook(mode, payload)
                self.assertEqual(code, 1, (mode, payload))
                self.assertIn("did not run", err)

    def test_unknown_mode_is_rejected(self):
        code, _, err = self.run_hook("bogus", {})
        self.assertEqual(code, 1)
        self.assertIn("usage:", err)


if __name__ == "__main__":
    unittest.main(verbosity=2)
