// Torch on the first prompt: the loaded handoff moves to the archive, once, and only when it is
// still the file this session loaded. Ported from v1's PromptSubmitTests and EntryPointTests.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { fixture, handoffText, SESSION } from './support.mjs'

async function loaded(t, body = 'Ship the widget.') {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body }))
  const out = await w.start()
  return { w, context: out.context }
}

test('first prompt archives the loaded handoff', async (t) => {
  const { w, context } = await loaded(t)
  const original = fs.readFileSync(w.handoff)
  const out = await w.prompt('/goal ship it')
  assert.ok(!fs.existsSync(w.handoff))
  const [archived] = w.archived()
  assert.deepEqual(fs.readFileSync(archived), original)
  assert.ok(context.includes(archived))
  assert.deepEqual(out.lines, [`Handoff archived to ${archived}`])
  assert.equal(out.context, `The auto-loaded handoff is now archived at ${archived}.`)
  assert.deepEqual(fs.readdirSync(w.archiveDir), [path.basename(archived)])
  assert.deepEqual(await w.host.$.store.keys(), [])
})

test('later prompts do nothing', async (t) => {
  const { w } = await loaded(t)
  await w.prompt()
  const out = await w.prompt('next')
  assert.deepEqual([out.banner, out.context], ['', ''])
  assert.equal(w.archived().length, 1)
})

test('load-handoff as first prompt leaves the file to the skill', async (t) => {
  for (const command of ['/torch:load-handoff', '/load-handoff', '  /torch:load-handoff please']) {
    await t.test(command, async (st) => {
      const { w } = await loaded(st)
      const out = await w.prompt(command)
      assert.deepEqual([out.banner, out.context], ['', ''])
      assert.ok(fs.existsSync(w.handoff))
      await w.prompt('now continue')
      assert.ok(fs.existsSync(w.handoff))
      assert.deepEqual(w.archived(), [])
    })
  }
})

test("another plugin's load-handoff command does not hold the file", async (t) => {
  const { w } = await loaded(t)
  await w.prompt('/someone-else:load-handoff')
  assert.ok(!fs.existsSync(w.handoff))
  assert.equal(w.archived().length, 1)
})

test('a handoff saved again since loading is kept for the next session', async (t) => {
  const { w } = await loaded(t)
  fs.writeFileSync(w.handoff, handoffText({ body: 'A newer plan.' }))
  const inode = fs.statSync(w.handoff).ino
  const bytes = fs.readFileSync(w.handoff)
  const out = await w.prompt()
  assert.equal(fs.statSync(w.handoff).ino, inode, 'the newer save must be left untouched')
  assert.deepEqual(fs.readFileSync(w.handoff), bytes)
  assert.match(out.banner, /changed after it was loaded/)
  assert.ok(out.context.includes(
    `The file at ${w.handoff} is that newer handoff, not the one loaded at session start`), out.context)
  assert.deepEqual(w.archived(), [])
  assert.deepEqual(fs.readdirSync(w.archiveDir), [])
})

test('a handoff removed since loading is ignored', async (t) => {
  const { w } = await loaded(t)
  fs.unlinkSync(w.handoff)
  const out = await w.prompt()
  assert.deepEqual([out.banner, out.context], ['', ''])
})

test('a prompt in a session that loaded nothing touches nothing', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha }))
  const runs = []
  w.host.intercept.run = (argv, real) => { runs.push(argv[0]); return real() }
  const out = await w.prompt()
  assert.deepEqual([out.banner, out.context], ['', ''])
  assert.ok(fs.existsSync(w.handoff))
  assert.deepEqual(runs, [], 'a prompt without a record starts no process')
})

test('an existing archive is never overwritten', async (t) => {
  const { w, context } = await loaded(t)
  const announced = context.split('it moves to ')[1].split(',')[0]
  fs.mkdirSync(path.dirname(announced), { recursive: true })
  fs.writeFileSync(announced, 'earlier archive')
  const out = await w.prompt()
  assert.equal(fs.readFileSync(announced, 'utf8'), 'earlier archive')
  assert.ok(!fs.existsSync(w.handoff))
  assert.equal(w.archived().length, 2)
  assert.match(out.banner, /-2\.md$/)
})

test('a corrupt session record is reported once and never blocks', async (t) => {
  const { w } = await loaded(t)
  await w.host.$.store.set(`session:${SESSION}`, 'not a record')
  const out = await w.prompt()
  assert.equal(out.lines.length, 1)
  assert.match(out.banner, /^could not archive the handoff: /)
  assert.equal(out.result?.block, undefined)
  const again = await w.prompt()
  assert.deepEqual([again.banner, again.context], ['', ''])
  assert.ok(fs.existsSync(w.handoff))
})

test('the next session after archiving loads nothing', async (t) => {
  const { w } = await loaded(t)
  await w.prompt()
  const out = await w.start({ session: '99999999-0000-0000-0000-000000000000' })
  assert.deepEqual([out.banner, out.context], ['', ''])
})

test('a first prompt another hook blocked leaves the handoff for the next prompt', async (t) => {
  const { w } = await loaded(t)
  const blocked = await w.host.fire('classic.UserPromptSubmit', {
    session_id: SESSION, cwd: w.repo, hook_event_name: 'UserPromptSubmit', prompt: 'go',
  }, async () => ({ block: 'not now' }))
  assert.deepEqual(blocked, { block: 'not now' })
  assert.ok(fs.existsSync(w.handoff))
  const out = await w.prompt('go')
  assert.ok(!fs.existsSync(w.handoff))
  assert.match(out.banner, /^Handoff archived to /)
})

test('a failure while loading is logged and the session starts', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha }))
  w.host.intercept.read = () => { throw new Error('disk on fire') }
  const result = await w.host.fire('classic.SessionStart', {
    session_id: SESSION, cwd: w.repo, hook_event_name: 'SessionStart', source: 'startup',
  }, async () => ({ additionalContext: ['other'] }))
  assert.deepEqual(result, { additionalContext: ['other'] })
  assert.deepEqual(w.host.logs, ['could not load the handoff: disk on fire'])
})

test('a failure while archiving is logged and the prompt goes through', async (t) => {
  const { w } = await loaded(t)
  w.host.intercept.run = (argv, real) => (argv[0] === 'mv'
    ? Promise.reject(new Error('mv: command not found')) : real())
  const result = await w.host.fire('classic.UserPromptSubmit', {
    session_id: SESSION, cwd: w.repo, hook_event_name: 'UserPromptSubmit', prompt: 'go',
  }, async () => ({ additionalContext: ['other'] }))
  assert.deepEqual(result, { additionalContext: ['other'] })
  assert.equal(w.host.logs.at(-1), `could not archive the handoff: mv could not claim ${w.handoff}: mv: command not found`)
  assert.ok(fs.existsSync(w.handoff))
})
