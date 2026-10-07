// Shared fixtures for Torch's node:test suites: a throwaway project, git helpers, and the two
// events fired through the mod the way Claude Code fires them.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHost } from './host.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MODULE = path.join(ROOT, 'hooks', 'torch.mjs')
export const SESSION = '11111111-2222-3333-4444-555555555555'
export const HANDOFF = 'handoff-before-clear.md'

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
}

export function iso(daysAgo = 0) {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// A handoff in the contract's shape; `front` replaces the whole front-matter block.
export function handoffText({ branch = 'main', head = 'none', body = 'Ship the widget.', savedAt, front } = {}) {
  const block = front ?? `---\nhandoff: 1\nsaved_at: ${savedAt ?? iso()}\nbranch: ${branch}\nhead: ${head}\n---\n`
  return `${block}# Handoff — test\n\nContinue the following task.\n\n## Goal\n\n${body}\n\n`
    + "## Current state\n\n```\n$ git status --short\n(clean)\n```\n\n## Absolute don'ts\n\n- Never push.\n"
}

// One test's world: a temporary folder with `home` and `repo`, and a host that has loaded the
// mod. The environment is hermetic: only PATH comes from the caller, to find git and the
// POSIX tools.
export async function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'torch-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const home = path.join(base, 'home')
  const repo = path.join(base, 'repo')
  fs.mkdirSync(home)
  fs.mkdirSync(repo)
  const env = {
    ...GIT_ENV, PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home,
    CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ATTENDED: '1',
  }
  const host = createHost({ env, cwd: repo })
  await host.load(MODULE)

  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
  const world = {
    base, home, repo, env, host, git,
    handoff: path.join(repo, HANDOFF),
    archiveDir: path.join(repo, '.claude', 'handoff-archive'),

    initRepo(branch = 'main') {
      git(['init', '-q', '-b', branch])
      git(['commit', '-q', '--allow-empty', '-m', 'init'])
      return git(['rev-parse', 'HEAD'])
    },

    writeHandoff(text, { root = repo, ageDays = 0 } = {}) {
      const file = path.join(root, HANDOFF)
      fs.writeFileSync(file, text)
      if (ageDays) {
        const stamp = (Date.now() - ageDays * 86_400_000) / 1000
        fs.utimesSync(file, stamp, stamp)
      }
      return file
    },

    // What one event left behind: the transcript lines it logged, and the context Torch added.
    // A classic event's context is its result's additionalContext; a prompt.submit's is the
    // context the message carried to the end of the chain.
    async fire(event, payload, { env: replacement, core } = {}) {
      const before = host.logs.length
      const run = () => host.fire(event, payload, core)
      const result = replacement ? await host.withEnv(replacement, run) : await run()
      const lines = host.logs.slice(before)
      const context = event === 'prompt.submit' ? (result?.context ?? []) : (result?.additionalContext ?? [])
      return { result, banner: lines.join('\n'), lines, context: context.join('\n') }
    },

    // A new session (or /clear) in `cwd`: Torch announces the handoff.
    start({ source = 'startup', cwd = repo, session = SESSION, env: replacement, core } = {}) {
      host.session.id = session
      host.session.cwd = cwd
      return world.fire('classic.SessionStart', {
        session_id: session, cwd, hook_event_name: 'SessionStart', source,
        transcript_path: path.join(home, 'transcript.jsonl'),
      }, { env: replacement, core })
    },

    // Torch reloads, or Claude Code restarts and the session is resumed: a new instance of the
    // module, with the same store and session.
    restart() {
      return world.host.reload(MODULE)
    },

    // A message in the current session, by default typed by the user. The core stands for Claude
    // Code taking the message in: it answers with the message as it arrived.
    prompt(text = 'carry on', { session, origin = 'composer', context, core } = {}) {
      if (session !== undefined) host.session.id = session
      const event = { text, wait: false, origin: { kind: origin }, ...(context ? { context } : {}) }
      return world.fire('prompt.submit', event, {
        core: core ?? (async (e) => ({ text: e.text, context: e.context, origin: e.origin })),
      })
    },

    // A session that starts and then gets the user's first message: what the user saw at the
    // start (banner, lines) and what Claude got with the message (context), with the message's
    // own report (delivered).
    async load(options = {}) {
      const { text = 'continue', ...startOptions } = options
      const start = await world.start(startOptions)
      const first = await world.prompt(text)
      return { banner: start.banner, lines: start.lines, start, context: first.context, delivered: first }
    },

    archived() {
      if (!fs.existsSync(world.archiveDir)) return []
      return fs.readdirSync(world.archiveDir).filter((name) => name.endsWith('.md')).sort()
        .map((name) => path.join(world.archiveDir, name))
    },

    // A PATH whose git fails when its arguments contain `failWhen`.
    fakeGit(failWhen) {
      const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { env, encoding: 'utf8' }).trim()
      const folder = path.join(home, 'fakebin')
      fs.mkdirSync(folder, { recursive: true })
      const script = path.join(folder, 'git')
      fs.writeFileSync(script, `#!/bin/sh\ncase "$*" in *${failWhen}*) exit 128;; esac\nexec "${real}" "$@"\n`)
      fs.chmodSync(script, 0o755)
      return { ...env, PATH: `${folder}:${env.PATH}` }
    },
  }
  return world
}
