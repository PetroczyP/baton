// Torch at session start: which handoff loads, what Claude and the user are told, and what is
// refused. Ported from v1's SessionStartTests, one test for one test.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { fixture, handoffText, iso, HANDOFF, SESSION } from './support.mjs'

function utf16Length(text) {
  return text.length
}

test('no handoff prints nothing', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  const out = await w.start()
  assert.equal(out.banner, '')
  assert.equal(out.context, '')
})

test('handoff is added to context with a banner', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body: 'Ship the purple widget.' }))
  const out = await w.start()
  assert.match(out.context, /Ship the purple widget\./)
  assert.match(out.context, /Never push\./)
  assert.equal(out.lines.length, 1)
  assert.ok(out.banner.startsWith('Handoff loaded: saved '), out.banner)
  for (const part of ['branch main ✓', 'no new commits', 'clean', 'Archived after your first message']) {
    assert.ok(out.banner.includes(part), part)
  }
})

test('headless sessions and other hosts are skipped', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha }))
  const unattended = { ...w.env, CLAUDE_CODE_SESSION_ATTENDED: '0' }
  const sdk = { ...w.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }
  delete sdk.CLAUDE_CODE_SESSION_ATTENDED
  const others = ['local-agent', 'local_agent', 'remote_cowork', 'remote_cowork_trigger', 'claude-coworker',
    'remote', 'remote_mobile', 'remote_trigger', 'sdk-py', 'mcp', 'claude-code-github-action',
    'claude-in-slack', 'claude_in_slack', 'claude-in-teams']
    .map((entrypoint) => ({ ...w.env, CLAUDE_CODE_ENTRYPOINT: entrypoint, CLAUDE_CODE_SESSION_ATTENDED: '1' }))
  for (const env of [unattended, sdk, ...others]) {
    const out = await w.start({ env })
    assert.deepEqual([out.banner, out.context], ['', ''], env.CLAUDE_CODE_ENTRYPOINT)
  }
  const after = await w.prompt()
  assert.deepEqual([after.banner, after.context], ['', ''])
  assert.ok(fs.existsSync(w.handoff))
  assert.deepEqual(await w.host.$.store.keys(), [])
})

test("Claude Code on the user's machine loads it", async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  for (const entrypoint of ['cli', 'claude-vscode', 'claude-desktop']) {
    w.writeHandoff(handoffText({ head: sha, body: `Loaded in ${entrypoint}.` }))
    const out = await w.start({ env: { ...w.env, CLAUDE_CODE_ENTRYPOINT: entrypoint } })
    assert.match(out.context, new RegExp(`Loaded in ${entrypoint}\\.`))
  }
})

test('the context does not claim who wrote the handoff', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha }))
  const out = await w.start()
  assert.match(out.context, /Torch does not check who wrote it\./)
  assert.doesNotMatch(out.context, /Claude wrote it/)
})

test('resumed, compacted and forked sessions are skipped', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha }))
  for (const source of ['resume', 'compact', 'fork']) {
    const out = await w.start({ source })
    assert.deepEqual([out.banner, out.context], ['', ''], source)
  }
})

test('clear loads like a new session', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body: 'After clear.' }))
  const out = await w.start({ source: 'clear' })
  assert.match(out.context, /After clear\./)
})

test('handoff at the repo root is found from a subdirectory', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  const sub = path.join(w.repo, 'src', 'deep')
  fs.mkdirSync(sub, { recursive: true })
  w.writeHandoff(handoffText({ head: sha, body: 'Found from below.' }))
  const out = await w.start({ cwd: sub })
  assert.match(out.context, /Found from below\./)
})

test('drift since the handoff is reported', async (t) => {
  const w = await fixture(t)
  const old = w.initRepo()
  w.writeHandoff(handoffText({ branch: 'feature/x', head: old }))
  w.git(['commit', '-q', '--allow-empty', '-m', 'two'])
  const now = w.git(['rev-parse', 'HEAD'])
  fs.writeFileSync(path.join(w.repo, 'notes.txt'), 'wip')
  const out = await w.start()
  for (const part of ['⚠ branch main, handoff was on feature/x',
    `⚠ HEAD moved since the handoff (${old.slice(0, 7)} → ${now.slice(0, 7)})`, '1 uncommitted change']) {
    assert.ok(out.banner.includes(part), part)
    assert.ok(out.context.includes(part), part)
  }
})

test('the handoff, its archive and a leftover claim are not uncommitted changes', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  fs.mkdirSync(w.archiveDir, { recursive: true })
  fs.writeFileSync(path.join(w.archiveDir, '20260101T000000Z.md'), '# Handoff\nold\n')
  fs.writeFileSync(path.join(w.repo, `.handoff-claim-${'0'.repeat(32)}.md`), '# Handoff\nkept\n')
  w.writeHandoff(handoffText({ head: sha }))
  const out = await w.start()
  assert.match(out.banner, /clean/)
})

test('a handoff without the contract loads without a comparison', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  w.writeHandoff('# Handoff — written before the contract\n\nOld-style plan.\n')
  const out = await w.start()
  assert.match(out.context, /Old-style plan\./)
  assert.ok(out.banner.includes('branch main · no saved git state to compare · clean'), out.banner)
})

test('front matter that breaks the contract counts as absent', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  const good = { handoff: '1', saved_at: iso(), branch: 'main', head: sha }
  const fronts = [
    { ...good, branch: '"main"' },
    { ...good, head: sha.slice(0, 7) },
    { ...good, saved_at: '2026-13-01T00:00:00Z' },
    { ...good, saved_at: '2026-02-30T00:00:00Z' },
    { ...good, handoff: '2' },
    Object.fromEntries(Object.entries(good).filter(([key]) => key !== 'head')),
  ].map((fields) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}\n`).join('')}---\n`)
  fronts.push(`---\nhandoff: 1\nhandoff: 1\nsaved_at: ${iso()}\nbranch: main\nhead: ${sha}\n---\n`)
  for (const front of fronts) {
    w.writeHandoff(handoffText({ front }))
    const out = await w.start()
    assert.ok(out.banner.includes('no saved git state to compare'), front)
  }
})

test('a detached HEAD matches the contract spelling', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.git(['checkout', '-q', '--detach'])
  w.writeHandoff(handoffText({ branch: '(detached)', head: sha }))
  const out = await w.start()
  assert.ok(out.banner.includes('branch (detached) ✓ · no new commits'), out.banner)
})

test('head none skips the commit comparison', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  w.writeHandoff(handoffText({ head: 'none' }))
  const out = await w.start()
  assert.ok(out.banner.includes('branch main ✓ · clean'), out.banner)
})

test('saved_at decides age and archive name, not the file time', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body: 'Copied today.', savedAt: iso(20) }))
  let out = await w.start()
  assert.match(out.banner, /older than 14 days/)
  const saved = iso(2)
  w.writeHandoff(handoffText({ head: sha, savedAt: saved }))
  out = await w.start()
  const stamp = saved.replaceAll('-', '').replaceAll(':', '')
  assert.ok(out.context.includes(`.claude/handoff-archive/${stamp}.md`), out.context)
})

test('a gitignored handoff is loaded', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  fs.writeFileSync(path.join(w.repo, '.gitignore'), `${HANDOFF}\n`)
  w.git(['add', '.gitignore'])
  w.git(['commit', '-q', '-m', 'ignore'])
  w.writeHandoff(handoffText({ head: w.git(['rev-parse', 'HEAD']), body: 'Ignored but mine.' }))
  const out = await w.start()
  assert.match(out.context, /Ignored but mine\./)
  assert.match(out.banner, /clean/)
})

test('a repo that hides untracked files still loads', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.git(['config', 'status.showUntrackedFiles', 'no'])
  w.writeHandoff(handoffText({ head: sha, body: 'Config does not hide me.' }))
  const out = await w.start()
  assert.match(out.context, /Config does not hide me\./)
})

test('a worktree is its own project root', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  const tree = path.join(w.base, 'tree')
  w.git(['worktree', 'add', '-q', '-b', 'side', tree])
  w.writeHandoff(handoffText({ branch: 'side', head: w.git(['rev-parse', 'HEAD']), body: 'In the worktree.' }),
    { root: tree })
  const out = await w.start({ cwd: tree })
  assert.match(out.context, /In the worktree\./)
  assert.ok(out.banner.includes('branch side ✓'), out.banner)
})

test('a repo handoff is not loaded when git cannot say if it is committed', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body: 'Unverifiable.' }))
  for (const env of [{ ...w.env, PATH: w.home }, w.fakeGit('--ignored')]) {
    const out = await w.start({ env })
    assert.match(out.banner, /Could not check with git/)
    assert.doesNotMatch(out.banner + out.context, /Unverifiable\./)
  }
})

test('a committed handoff is caught even when the tree status fails', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  w.writeHandoff(handoffText({ body: 'Committed plan.' }))
  w.git(['add', HANDOFF])
  w.git(['commit', '-q', '-m', 'oops'])
  const out = await w.start({ env: w.fakeGit('--branch') })
  assert.match(out.banner, /is committed to this repo/)
  assert.doesNotMatch(out.banner + out.context, /Committed plan\./)
})

test('drift reads unavailable when only the tree status fails', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body: 'Still mine.' }))
  const out = await w.start({ env: w.fakeGit('--branch') })
  assert.match(out.context, /Still mine\./)
  assert.match(out.banner, /git state unavailable/)
})

test('handoff without its title is not loaded', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  w.writeHandoff('# Handoffs and other notes\njust some notes\n')
  const out = await w.start()
  assert.match(out.banner, /no '# Handoff' title/)
  assert.equal(out.context, '')
  const after = await w.prompt()
  assert.deepEqual([after.banner, after.context], ['', ''])
  assert.ok(fs.existsSync(w.handoff))
})

test('a symlinked handoff is announced and left alone', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  fs.writeFileSync(path.join(w.repo, 'real.md'), handoffText({ body: 'Behind a link.' }))
  fs.symlinkSync('real.md', w.handoff)
  const out = await w.start()
  assert.match(out.banner, /is a symbolic link/)
  assert.doesNotMatch(out.banner + out.context, /Behind a link\./)
  const after = await w.prompt()
  assert.deepEqual([after.banner, after.context], ['', ''])
  assert.ok(fs.lstatSync(w.handoff).isSymbolicLink())
  assert.deepEqual(w.archived(), [])
})

test('a symbolic link that leads nowhere is announced too', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  fs.symlinkSync('missing.md', w.handoff)
  const out = await w.start()
  assert.match(out.banner, /is a symbolic link/)
  assert.equal(out.context, '')
})

test('committed handoff is not loaded', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  w.writeHandoff(handoffText({ body: "Someone else's plan." }))
  w.git(['add', HANDOFF])
  w.git(['commit', '-q', '-m', 'oops'])
  const out = await w.start()
  assert.match(out.banner, /is committed to this repo/)
  assert.doesNotMatch(out.banner + out.context, /Someone else's plan\./)
})

test('old handoff is announced but not loaded or archived', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body: 'Stale plan.', savedAt: iso(15) }))
  const out = await w.start()
  assert.match(out.banner, /older than 14 days/)
  assert.equal(out.context, '')
  await w.prompt()
  assert.ok(fs.existsSync(w.handoff))
})

test('a handoff without the contract is aged by its file time', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  w.writeHandoff('# Handoff\n\nOld file.\n', { ageDays: 15 })
  const out = await w.start()
  assert.match(out.banner, /older than 14 days/)
  assert.equal(out.context, '')
})

test('handoff just inside the age limit is loaded', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body: 'Recent enough.', savedAt: iso(13.9) }))
  const out = await w.start()
  assert.match(out.context, /Recent enough\./)
})

test('large handoff is pointed to, not inlined', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  const file = w.writeHandoff(handoffText({ head: sha, body: `UNIQUE-BODY ${'x'.repeat(12_000)}` }))
  const out = await w.start()
  assert.doesNotMatch(out.context, /UNIQUE-BODY/)
  assert.ok(out.context.includes(file))
  assert.ok(out.context.includes('.claude/handoff-archive/'))
  assert.ok(utf16Length(out.context) <= 10_000)
  assert.match(out.banner, /Claude reads it from the file/)
})

test('the inline limit counts UTF-16 units', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  const text = handoffText({ head: sha, body: '\u{1F680}'.repeat(5_200) })
  assert.ok([...text].length < 9_000)
  w.writeHandoff(text)
  const out = await w.start()
  assert.ok(!out.context.includes('\u{1F680}\u{1F680}'))
  assert.ok(utf16Length(out.context) <= 10_000)
})

test('outside a git repo the handoff still loads', async (t) => {
  const w = await fixture(t)
  w.writeHandoff(handoffText({ body: 'No repo here.' }))
  const out = await w.start()
  assert.match(out.context, /No repo here\./)
  assert.match(out.banner, /not a git repo/)
})

test('session without a usable id loads but keeps the file', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body: 'Odd session id.' }))
  for (const session of ['../escape', '', 'x'.repeat(129)]) {
    const out = await w.start({ session })
    assert.match(out.context, /Odd session id\./)
    assert.match(out.banner, /will not be archived automatically/)
  }
  const missing = await w.fire('classic.SessionStart', { cwd: w.repo, hook_event_name: 'SessionStart', source: 'startup' })
  assert.match(missing.banner, /will not be archived automatically/)
  assert.deepEqual(await w.host.$.store.keys(), [])
})

test('records of sessions that never prompted expire', async (t) => {
  const w = await fixture(t)
  const now = Date.now()
  await w.host.$.store.set('session:old-session', { handoff: '/x', sha256: 'a', archiveTo: '/y', at: now - 31 * 86_400_000 })
  await w.host.$.store.set('session:new-session', { handoff: '/x', sha256: 'a', archiveTo: '/y', at: now })
  await w.host.$.store.set('session:no-time', {})
  await w.host.$.store.set('unrelated', 1)
  w.initRepo()
  await w.start()
  assert.deepEqual((await w.host.$.store.keys()).sort(), ['session:new-session', 'unrelated'])
})

test('a handoff over 4 MiB is announced, not loaded', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  w.writeHandoff(handoffText({ body: 'y'.repeat(4 * 1024 * 1024) }))
  const out = await w.start()
  assert.match(out.banner, /is over 4 MiB, so it was not loaded/)
  assert.equal(out.context, '')
  assert.deepEqual(await w.host.$.store.keys(), [])
})

test('a session folder that is not a POSIX path is told Torch does not support it', async (t) => {
  const w = await fixture(t)
  const out = await w.start({ cwd: 'C:\\Users\\me\\project' })
  assert.deepEqual(out.lines, ['Torch supports macOS and Linux; the handoff was not loaded.'])
  assert.equal(out.context, '')
})

test('the context sits beside what other hooks added', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body: 'Mine.' }))
  const result = await w.host.fire('classic.SessionStart', {
    session_id: SESSION, cwd: w.repo, hook_event_name: 'SessionStart', source: 'startup',
  }, async () => ({ additionalContext: ['from a settings hook'], sessionTitle: 'kept' }))
  assert.equal(result.additionalContext[0], 'from a settings hook')
  assert.match(result.additionalContext[1], /Mine\./)
  assert.equal(result.sessionTitle, 'kept')
})

test('truncated git output counts as git failing', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body: 'Huge repo.' }))
  const truncate = (marker) => async (argv, real) => {
    const done = await real()
    return argv.includes(marker) ? { ...done, isStdoutTruncated: true } : done
  }
  w.host.intercept.run = truncate('--branch')
  let out = await w.start()
  assert.match(out.context, /Huge repo\./)
  assert.match(out.banner, /git state unavailable/)
  w.host.intercept.run = truncate('--ignored=traditional')
  out = await w.start()
  assert.match(out.banner, /Could not check with git/)
  assert.equal(out.context, '')
})

test('a leading byte-order mark is dropped before the contract and title are read', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(`\uFEFF${handoffText({ head: sha, body: 'Saved with a BOM.' })}`)
  const out = await w.start()
  assert.match(out.context, /Saved with a BOM\./)
  assert.ok(out.banner.includes('branch main ✓ · no new commits'), out.banner)
})

test('the nearest repository is the project root', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  const inner = path.join(w.repo, 'vendor', 'inner')
  fs.mkdirSync(inner, { recursive: true })
  w.git(['init', '-q', '-b', 'inner-main'], inner)
  w.git(['commit', '-q', '--allow-empty', '-m', 'i'], inner)
  w.writeHandoff(handoffText({ branch: 'inner-main', body: 'The inner one.' }), { root: inner })
  w.writeHandoff(handoffText({ body: 'The outer one.' }))
  const out = await w.start({ cwd: path.join(inner) })
  assert.match(out.context, /The inner one\./)
  assert.ok(out.banner.includes('branch inner-main ✓'), out.banner)
})

test('a handoff path that is a folder is silently ignored', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  fs.mkdirSync(w.handoff)
  const out = await w.start()
  assert.deepEqual([out.banner, out.context], ['', ''])
})

test('a handoff just past 14 days is announced, not loaded', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body: 'Just too old.', savedAt: iso(14.01) }))
  const out = await w.start()
  assert.match(out.banner, /older than 14 days/)
  assert.equal(out.context, '')
})

test('when the store refuses the record, the handoff loads and stays in place', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body: 'Unrecorded.' }))
  w.host.$.store.set = async () => { throw new Error('the store is full') }
  const out = await w.start()
  assert.match(out.context, /Unrecorded\./)
  assert.match(out.context, /It stays in place: this session could not be recorded for archiving\./)
  assert.match(out.banner, /It will not be archived automatically\./)
})

test('an archive name taken before the session started is skipped in the announcement', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  const saved = iso()
  w.writeHandoff(handoffText({ head: sha, savedAt: saved }))
  const stamp = saved.replaceAll('-', '').replaceAll(':', '')
  fs.mkdirSync(w.archiveDir, { recursive: true })
  fs.writeFileSync(path.join(w.archiveDir, `${stamp}.md`), 'taken')
  const out = await w.start()
  assert.ok(out.context.includes(`it moves to ${path.join(w.archiveDir, `${stamp}-2.md`)},`), out.context)
})

test('records expire after 30 days, not before', async (t) => {
  const w = await fixture(t)
  const day = 86_400_000
  await w.host.$.store.set('session:just-in', { at: Date.now() - 30 * day + 60_000 })
  await w.host.$.store.set('session:just-out', { at: Date.now() - 30 * day - 60_000 })
  await w.start()
  assert.deepEqual(await w.host.$.store.keys(), ['session:just-in'])
})

test('a handoff of exactly 4 MiB is read and pointed to', async (t) => {
  const w = await fixture(t)
  w.initRepo()
  const head = '# Handoff\n\n'
  w.writeHandoff(head + 'z'.repeat(4 * 1024 * 1024 - head.length))
  const out = await w.start()
  assert.match(out.context, /too long to include here/)
  assert.match(out.banner, /Claude reads it from the file/)
})
