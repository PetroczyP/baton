"""Tests for Torch as a plugin: hooks.json, the two shell wrappers, and what the directory checks.

The hook commands are run the way Claude Code runs them: `${CLAUDE_PLUGIN_ROOT}` substituted into
the command from hooks.json, the result passed to `sh -c`, the hook input on stdin and the plugin
variables in the environment. The plugin root and data folder have spaces in their paths, so the
quoting is exercised too.

Run:  python3 tests/test_plugin.py      (or: python3 -m pytest tests/ -q)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def hook_commands() -> dict:
    config = json.loads((ROOT / "hooks" / "hooks.json").read_text())
    return {event: groups for event, groups in config["hooks"].items()}


def front_matter(path: Path) -> dict:
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[0] == "---", path
    end = lines.index("---", 1)
    return dict(line.split(": ", 1) for line in lines[1:end])


class PluginCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name).resolve()
        self.root = base / "plugin root"
        shutil.copytree(ROOT / "hooks", self.root / "hooks")
        self.data = base / "plugin data"
        self.home = base / "home"
        self.home.mkdir()
        self.repo = base / "my project"
        self.repo.mkdir()
        # A hermetic environment: only PATH comes from the caller, to find git, sh and python3.
        self.env = dict(PATH=os.environ.get("PATH", "/usr/bin:/bin"), HOME=str(self.home),
                        CLAUDE_PLUGIN_ROOT=str(self.root), CLAUDE_PLUGIN_DATA=str(self.data),
                        CLAUDE_CODE_ENTRYPOINT="cli", CLAUDE_CODE_SESSION_ATTENDED="1",
                        GIT_CONFIG_NOSYSTEM="1")
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=self.repo, env=self.env, check=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_event(self, event: str, payload: object, env: dict | None = None):
        """Run the event's command; a dict payload is sent as Claude Code sends it, one compact line."""
        [group] = hook_commands()[event]
        [hook] = group["hooks"]
        command = hook["command"].replace("${CLAUDE_PLUGIN_ROOT}", str(self.root))
        stdin = payload if isinstance(payload, str) else json.dumps(payload, separators=(",", ":")) + "\n"
        return subprocess.run(["/bin/sh", "-c", command], input=stdin, env=env or self.env,
                              capture_output=True, text=True, timeout=60)

    def payload(self, event: str, **extra: str) -> dict:
        return {"session_id": SESSION, "cwd": str(self.repo), "hook_event_name": event, **extra}


class HooksJsonTests(PluginCase):
    def test_both_events_point_at_scripts_inside_the_plugin(self):
        hooks = hook_commands()
        self.assertEqual(set(hooks), {"SessionStart", "UserPromptSubmit"})
        self.assertEqual(hooks["SessionStart"][0]["matcher"], "startup|clear")
        for event, script in (("SessionStart", "session-start.sh"), ("UserPromptSubmit", "prompt-submit.sh")):
            [hook] = hooks[event][0]["hooks"]
            self.assertEqual(hook["command"], f'sh "${{CLAUDE_PLUGIN_ROOT}}/hooks/{script}"')
            self.assertTrue((ROOT / "hooks" / script).is_file())

    def test_the_commands_load_and_then_archive_a_handoff(self):
        (self.repo / "handoff-before-clear.md").write_text("# Handoff\n\nShip the green widget.\n")
        start = self.run_event("SessionStart", self.payload("SessionStart", source="startup"))
        self.assertEqual(start.returncode, 0, start.stderr)
        self.assertIn("Ship the green widget.", json.loads(start.stdout)["hookSpecificOutput"]["additionalContext"])
        self.assertTrue((self.data / "sessions" / f"{SESSION}.json").is_file())
        submit = self.run_event("UserPromptSubmit", self.payload("UserPromptSubmit", prompt="go"))
        self.assertEqual(submit.returncode, 0, submit.stderr)
        self.assertIn("Handoff archived to", json.loads(submit.stdout)["systemMessage"])
        self.assertFalse((self.repo / "handoff-before-clear.md").exists())
        self.assertEqual(list((self.data / "sessions").iterdir()), [])


    def test_the_readme_quotes_the_instructions_the_hook_gives_claude(self):
        (self.repo / "handoff-before-clear.md").write_text("# Handoff\n\nAnything.\n")
        start = self.run_event("SessionStart", self.payload("SessionStart", source="startup"))
        context = json.loads(start.stdout)["hookSpecificOutput"]["additionalContext"]
        guidance = context.split("How to use it:\n", 1)[1].split("\n\n", 1)[0].splitlines()
        self.assertEqual(len(guidance), 3, guidance)
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        for line in guidance:
            self.assertIn(f"> {line}\n", readme)


class WrapperTests(PluginCase):
    def replace_hook_with_a_sentinel(self) -> Path:
        """Swap the Python hook for one that records each run and the exact input it received."""
        received = self.home / "python-received"
        (self.root / "hooks" / "handoff-autoload.py").write_text(
            "import sys\n"
            f"open({str(received)!r}, 'a').write(sys.argv[1] + '|' + sys.stdin.read() + '\\n---\\n')\n")
        return received

    def record_for(self, session: str) -> None:
        record = self.data / "sessions" / f"{session}.json"
        record.parent.mkdir(parents=True, exist_ok=True)
        record.write_text("{}")

    def test_prompt_submit_starts_python_only_for_a_session_with_a_record(self):
        received = self.replace_hook_with_a_sentinel()
        prompt = self.payload("UserPromptSubmit", prompt='go "now" \\ please')
        self.run_event("UserPromptSubmit", prompt)
        self.assertFalse(received.exists(), "started Python for a session with no record")
        self.record_for("ffffffff-0000-0000-0000-000000000000")
        self.run_event("UserPromptSubmit", prompt)
        self.assertFalse(received.exists(), "started Python for another session's record")
        self.record_for(SESSION)
        self.run_event("UserPromptSubmit", prompt)
        line = json.dumps(prompt, separators=(",", ":"))
        self.assertEqual(received.read_text(), f"prompt-submit|{line}\n\n---\n")

    def test_input_the_shell_cannot_read_goes_to_python_unchanged(self):
        received = self.replace_hook_with_a_sentinel()
        pretty = json.dumps(self.payload("UserPromptSubmit", prompt="go"), indent=2) + "\n"
        self.run_event("UserPromptSubmit", pretty)
        self.assertEqual(received.read_text(), f"prompt-submit|{pretty}\n---\n")

    def test_session_start_without_python_says_so_and_does_not_block(self):
        only_sh = self.home / "bin"
        only_sh.mkdir()
        (only_sh / "sh").symlink_to("/bin/sh")
        no_python = dict(self.env, PATH=str(only_sh))
        done = self.run_event("SessionStart", self.payload("SessionStart", source="startup"), no_python)
        self.assertEqual(done.returncode, 1)
        self.assertIn("python3 (3.9 or newer) was not found", done.stderr)
        self.assertEqual(done.stdout, "")


class DirectoryRequirementTests(unittest.TestCase):
    """What Anthropic's directory checks before it lists a plugin."""

    def test_manifest_has_the_listing_fields(self):
        manifest = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text())
        self.assertEqual(manifest["name"], "torch")
        self.assertRegex(manifest["version"], r"^\d+\.\d+\.\d+$")
        for key in ("description", "license", "homepage", "repository"):
            self.assertTrue(manifest[key], key)
        self.assertTrue(manifest["author"]["name"])
        self.assertTrue((ROOT / manifest["icon"]).is_file())
        for key in ("homepage", "documentationUrl", "supportUrl", "privacyPolicyUrl"):
            address = urlsplit(manifest[key])
            self.assertEqual((address.scheme, bool(address.netloc)), ("https", True), key)

    def test_license_and_readme(self):
        self.assertTrue((ROOT / "LICENSE").is_file())
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        prose = re.sub(r"```.*?```", "", readme, flags=re.S)
        self.assertGreaterEqual(len(prose.split()), 40)

    def test_each_skill_has_parseable_front_matter(self):
        for skill in sorted((ROOT / "skills").iterdir()):
            fields = front_matter(skill / "SKILL.md")
            self.assertEqual(fields["name"], skill.name)
            self.assertTrue(fields["description"].strip())

    def test_no_system_files_or_oversized_files(self):
        for path in ROOT.rglob("*"):
            if ".git" in path.parts or "__pycache__" in path.parts or not path.is_file():
                continue
            self.assertNotIn(path.name, {".DS_Store", "Thumbs.db", "desktop.ini"}, path)
            self.assertLess(path.stat().st_size, 256 * 1024, path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
