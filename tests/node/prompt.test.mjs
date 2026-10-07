// Torch on the user's first message: the announced handoff reaches Claude with that message and
// moves to the archive, once, and only when it is still the file announced at session start.
// Ported from v1's PromptSubmitTests and EntryPointTests, plus 2.1's rules for who sends the
// first message and what happens when a later hook refuses it.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { fixture, handoffText, SESSION } from './support.mjs'

// A session that announced a handoff and hasn't had a message yet.
async function announced(t, body = 'Ship the widget.') {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha, body }))
  const start = await w.start()
  return { w, start }
}

const ran = (exitCode, stderr = '') => ({ exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })

test('the first message carries the handoff to Claude and archives it', async (t) => {
  const { w, start } = await announced(t)
  assert.equal(start.context, '', 'nothing reaches Claude at session start')
  const original = fs.readFileSync(w.handoff)
  const out = await w.prompt('/goal ship it')
  assert.ok(!fs.existsSync(w.handoff))
  const [archived] = w.archived()
  assert.deepEqual(fs.readFileSync(archived), original)
  assert.deepEqual(out.lines, [`Handoff archived to ${archived}`])
  assert.match(out.context, /Ship the widget\./)
  assert.ok(out.context.includes(`File: ${w.handoff}, saved `), out.context)
  assert.ok(out.context.includes(`It is now archived at ${archived}.`), out.context)
  assert.deepEqual(fs.readdirSync(w.archiveDir), [path.basename(archived)])
  assert.deepEqual(await w.host.$.store.keys(), [])
})

test('later messages pass on unchanged', async (t) => {
  const { w } = await announced(t)
  await w.prompt()
  const out = await w.prompt('next')
  assert.deepEqual([out.banner, out.context], ['', ''])
  assert.equal(w.archived().length, 1)
})

test('load-handoff as the first message leaves the file to the skill', async (t) => {
  for (const command of ['/torch:load-handoff', '/load-handoff', '  /torch:load-handoff please']) {
    await t.test(command, async (st) => {
      const { w } = await announced(st)
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
  const { w } = await announced(t)
  await w.prompt('/someone-else:load-handoff')
  assert.ok(!fs.existsSync(w.handoff))
  assert.equal(w.archived().length, 1)
})

test('a handoff saved again since the announcement is kept for the next session', async (t) => {
  const { w } = await announced(t)
  fs.writeFileSync(w.handoff, handoffText({ body: 'A newer plan.' }))
  const inode = fs.statSync(w.handoff).ino
  const bytes = fs.readFileSync(w.handoff)
  const out = await w.prompt()
  assert.equal(fs.statSync(w.handoff).ino, inode, 'the newer save must be left untouched')
  assert.deepEqual(fs.readFileSync(w.handoff), bytes)
  assert.match(out.banner, /changed after it was announced, so Claude didn't get it/)
  assert.ok(out.context.startsWith('No handoff was delivered with this message.'), out.context)
  assert.ok(out.context.includes(
    `The file at ${w.handoff} is that newer handoff, not the one announced at session start`), out.context)
  assert.doesNotMatch(out.context, /A newer plan\./)
  assert.deepEqual(w.archived(), [])
  assert.deepEqual(fs.readdirSync(w.archiveDir), [])
})

test('a handoff removed since the announcement is reported, and Claude gets nothing', async (t) => {
  const { w } = await announced(t)
  fs.unlinkSync(w.handoff)
  const out = await w.prompt()
  assert.deepEqual(out.lines, ["handoff-before-clear.md was gone before your first message, so Claude didn't get it."])
  assert.equal(out.context, '')
})

test('a message in a session that announced nothing touches nothing', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha }))
  w.host.session.id = SESSION
  const runs = []
  w.host.intercept.run = (argv, real) => { runs.push(argv[0]); return real() }
  const out = await w.prompt()
  assert.deepEqual([out.banner, out.context], ['', ''])
  assert.ok(fs.existsSync(w.handoff))
  assert.deepEqual(runs, [], 'a message without a record starts no process')
})

test('an existing archive is never overwritten', async (t) => {
  const { w } = await announced(t)
  const record = await w.host.$.store.get(`session:${SESSION}`)
  fs.mkdirSync(path.dirname(record.archiveTo), { recursive: true })
  fs.writeFileSync(record.archiveTo, 'earlier archive')
  const out = await w.prompt()
  assert.equal(fs.readFileSync(record.archiveTo, 'utf8'), 'earlier archive')
  assert.ok(!fs.existsSync(w.handoff))
  assert.equal(w.archived().length, 2)
  assert.match(out.banner, /-2\.md$/)
})

test('a session record that is not valid is reported once and never stops the message', async (t) => {
  const good = (w) => ({ handoff: w.handoff, sha256: 'x', archiveTo: path.join(w.archiveDir, 'a.md'), savedTs: Date.now() / 1000, drift: ['clean'], at: Date.now() })
  const broken = {
    'no archive path': (r) => ({ ...r, archiveTo: undefined }),
    'no save time': (r) => ({ ...r, savedTs: undefined }),
    'a save time that is not a number': (r) => ({ ...r, savedTs: 'yesterday' }),
    'no drift': (r) => ({ ...r, drift: undefined }),
    'drift that is not text': (r) => ({ ...r, drift: [1] }),
    'a save time no date can hold': (r) => ({ ...r, savedTs: 1e20 }),
  }
  for (const [label, breakIt] of Object.entries(broken)) {
    await t.test(label, async (st) => {
      const { w } = await announced(st)
      await w.host.$.store.set(`session:${SESSION}`, breakIt(good(w)))
      const out = await w.prompt()
      assert.deepEqual(out.lines, ['could not deliver the handoff: the session record is not valid'])
      assert.deepEqual(out.result, { text: 'carry on', context: undefined, origin: { kind: 'composer' } })
      const again = await w.prompt()
      assert.deepEqual([again.banner, again.context], ['', ''])
      assert.ok(fs.existsSync(w.handoff))
    })
  }
})
test('the next session after archiving announces nothing', async (t) => {
  const { w } = await announced(t)
  await w.prompt()
  const out = await w.start({ session: '99999999-0000-0000-0000-000000000000' })
  assert.deepEqual([out.banner, out.context], ['', ''])
})

test('only a message the user sent counts as the first message', async (t) => {
  for (const origin of ['task-notification', 'peer', 'peer-send-message', 'scheduled-trigger', 'plugin', 'sdk',
    'channel', 'coordinator', 'auto-continuation', 'unclassified']) {
    await t.test(origin, async (st) => {
      const { w } = await announced(st)
      const out = await w.prompt('a notification', { origin })
      assert.deepEqual([out.banner, out.context], ['', ''])
      assert.ok(fs.existsSync(w.handoff))
      assert.deepEqual(await w.host.$.store.keys(), [`session:${SESSION}`])
      const user = await w.prompt('continue')
      assert.match(user.context, /Ship the widget\./)
    })
  }
  for (const origin of ['composer', 'bridge']) {
    await t.test(origin, async (st) => {
      const { w } = await announced(st)
      const out = await w.prompt('continue', { origin })
      assert.match(out.context, /Ship the widget\./)
    })
  }
})

test('a message without an origin is not taken for the user\'s', async (t) => {
  const { w } = await announced(t)
  const out = await w.fire('prompt.submit', { text: 'continue', wait: false },
    { core: async (e) => ({ text: e.text, context: e.context }) })
  assert.deepEqual([out.banner, out.context], ['', ''])
  assert.ok(fs.existsSync(w.handoff))
})

test('two overlapping messages of one session act at most once', async (t) => {
  const { w } = await announced(t)
  const [skill, second] = await Promise.all([w.prompt('/torch:load-handoff'), w.prompt('continue')])
  assert.deepEqual([skill.context, second.context], ['', ''])
  assert.ok(fs.existsSync(w.handoff), 'the skill was first, so the file is left to it')
  assert.deepEqual(w.archived(), [])
  assert.deepEqual(await w.host.$.store.keys(), [])
})

test('a first message a later hook refuses passes back untouched; the handoff is archived, not delivered', async (t) => {
  const { w } = await announced(t)
  let carried
  const out = await w.prompt('go', { core: async (e) => { carried = e.context; return { drop: 'not now' } } })
  assert.deepEqual(out.result, { drop: 'not now' })
  assert.match(carried.join('\n'), /Ship the widget\./, 'the context went down with the message')
  assert.equal(w.archived().length, 1)
  const next = await w.prompt('go again')
  assert.deepEqual([next.banner, next.context], ['', ''], 'no retry')
})

test('a first load-handoff whose record could not be deleted still leaves the file to the skill', async (t) => {
  const { w } = await announced(t)
  const remove = w.host.$.store.delete
  w.host.$.store.delete = async () => { throw new Error('the store is busy') }
  const skill = await w.prompt('/torch:load-handoff')
  w.host.$.store.delete = remove
  assert.deepEqual(skill.lines, ['could not deliver the handoff: the store is busy'])
  const next = await w.prompt('keep going')
  assert.deepEqual([next.banner, next.context], ['', ''])
  assert.ok(fs.existsSync(w.handoff), 'the file stays with the skill')
  assert.deepEqual(w.archived(), [])
})

test('a failure while announcing is logged and the session starts', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha }))
  w.host.intercept.read = () => { throw new Error('disk on fire') }
  const settings = { additionalContext: ['other'] }
  const out = await w.start({ core: async () => settings })
  assert.equal(out.result, settings)
  assert.deepEqual(w.host.logs, ['could not announce the handoff: disk on fire'])
})

test('a failure while delivering is logged and the message goes through', async (t) => {
  const { w } = await announced(t)
  w.host.intercept.run = (argv, real) => (argv[0] === 'mv'
    ? Promise.reject(new Error('mv: command not found')) : real())
  const out = await w.prompt('go', { context: ['other'] })
  assert.deepEqual(out.result.context, ['other'])
  assert.equal(out.result.text, 'go')
  assert.equal(w.host.logs.at(-1), `could not deliver the handoff: mv could not claim ${w.handoff}: mv: command not found`)
  assert.ok(fs.existsSync(w.handoff))
})

test('a command that only starts like load-handoff is a first message like any other', async (t) => {
  for (const command of ['/load-handoff-extra', '/torch:load-handoffs', '/torch:load-handoff-now']) {
    await t.test(command, async (st) => {
      const { w } = await announced(st)
      await w.prompt(command)
      assert.ok(!fs.existsSync(w.handoff))
      assert.equal(w.archived().length, 1)
    })
  }
})

test('the first message keeps its text and origin, and gains only Torch\'s context', async (t) => {
  const { w } = await announced(t)
  const out = await w.prompt('go', { context: ['from a prompt hook'] })
  assert.deepEqual(Object.keys(out.result).sort(), ['context', 'origin', 'text'])
  assert.equal(out.result.text, 'go')
  assert.deepEqual(out.result.origin, { kind: 'composer' })
  assert.equal(out.result.context.length, 2)
  assert.equal(out.result.context[0], 'from a prompt hook')
})

test("one session's message never touches another session's record or handoff", async (t) => {
  const { w } = await announced(t)
  const other = '33333333-0000-0000-0000-000000000000'
  const out = await w.prompt('go', { session: other })
  assert.deepEqual([out.banner, out.context], ['', ''])
  assert.ok(fs.existsSync(w.handoff))
  assert.deepEqual(await w.host.$.store.keys(), [`session:${SESSION}`])
})

test('a message from a folder that is not a POSIX path touches nothing', async (t) => {
  const { w } = await announced(t)
  w.host.session.cwd = 'C:\\work'
  const runs = []
  w.host.intercept.run = (argv, real) => { runs.push(argv[0]); return real() }
  const store = w.host.$.store
  const reads = []
  w.host.$.store = Object.fromEntries(Object.entries(store).map(([name, call]) => [name, (...args) => {
    reads.push(name)
    return call(...args)
  }]))
  const out = await w.prompt('go')
  w.host.$.store = store
  assert.deepEqual([out.lines, out.context, runs, reads], [[], '', [], []])
  assert.deepEqual(await w.host.$.store.keys(), [`session:${SESSION}`])
  assert.ok(fs.existsSync(w.handoff))
})

test('after a failed delivery the session tries no more, and the message runs once', async (t) => {
  const { w } = await announced(t)
  w.host.intercept.run = (argv, real) => (argv[0] === 'mkdir' ? Promise.reject(new Error('mkdir: denied')) : real())
  let downstream = 0
  const core = async (e) => { downstream += 1; return { text: e.text, context: e.context, origin: e.origin } }
  await w.prompt('go', { core })
  assert.equal(downstream, 1)
  assert.equal(w.host.logs.at(-1), 'could not deliver the handoff: mkdir: denied')
  const logged = w.host.logs.length
  await w.prompt('go', { core })
  assert.equal(downstream, 2)
  assert.equal(w.host.logs.length, logged, 'the second message logs nothing')
  assert.ok(fs.existsSync(w.handoff))
})

test('when it cannot be told whether a link was made, the claim is kept, named and delivered', async (t) => {
  const { w } = await announced(t)
  const original = fs.readFileSync(w.handoff)
  w.host.intercept.run = (argv, real) => (argv[0] === 'link' ? Promise.resolve(ran(1, 'link: failed')) : real())
  const exists = w.host.$.fs.exists
  w.host.$.fs.exists = async (file) => {
    if (file.includes('handoff-archive')) throw new Error('a policy refused it')
    return exists(file)
  }
  const out = await w.prompt('go')
  const [claim] = fs.readdirSync(w.repo).filter((name) => name.startsWith('.handoff-claim-'))
  const kept = path.join(w.repo, claim)
  assert.deepEqual(fs.readFileSync(kept), original)
  assert.ok(out.banner.includes(kept), out.banner)
  assert.ok(out.context.includes(`It could not be archived and is now at ${kept}.`), out.context)
  assert.match(out.context, /Ship the widget\./)
  assert.deepEqual(await w.host.$.store.keys(), [])
})

test('a temporary name that could not be removed is reported to the user and to Claude', async (t) => {
  const cases = {
    'rm fails, the name stays': { run: () => ({ exitCode: 1 }), leftover: true },
    'rm reports failure after removing it': { run: async (real) => ({ ...(await real()), exitCode: 1 }), leftover: false },
    'the rm call fails after removing it': { run: async (real) => { await real(); throw new Error('rm: lost') }, leftover: false },
    'rm fails and the name cannot be checked': { run: () => ({ exitCode: 1 }), leftover: true, blindExists: true },
  }
  for (const [label, c] of Object.entries(cases)) {
    await t.test(label, async (st) => {
      const { w } = await announced(st)
      w.host.intercept.run = async (argv, real) => (argv[0] === 'rm'
        ? { stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...(await c.run(real)) }
        : real())
      if (c.blindExists) {
        const exists = w.host.$.fs.exists
        w.host.$.fs.exists = async (file) => {
          if (path.basename(file).startsWith('.handoff-claim-')) throw new Error('a policy refused it')
          return exists(file)
        }
      }
      const out = await w.prompt('go')
      const [archived] = w.archived()
      assert.ok(out.banner.startsWith(`Handoff archived to ${archived}`), out.banner)
      const claims = fs.readdirSync(w.repo).filter((name) => name.startsWith('.handoff-claim-'))
      if (c.leftover) {
        const leftover = path.join(w.repo, claims[0])
        assert.ok(out.banner.includes(`${leftover}, which may remain`), out.banner)
        assert.ok(out.context.includes(`${leftover}, which may remain`), out.context)
      } else {
        assert.deepEqual(claims, [])
        assert.deepEqual(out.lines, [`Handoff archived to ${archived}`])
      }
    })
  }
})

test('a changed handoff whose temporary name could not be removed is reported to both', async (t) => {
  const { w } = await announced(t)
  fs.writeFileSync(w.handoff, handoffText({ body: 'A newer plan.' }))
  w.host.intercept.run = async (argv, real) => (argv[0] === 'rm' ? ran(1, 'rm: denied') : real())
  const out = await w.prompt('go')
  const [claim] = fs.readdirSync(w.repo).filter((name) => name.startsWith('.handoff-claim-'))
  const leftover = path.join(w.repo, claim)
  assert.match(out.banner, /changed after it was announced/)
  assert.ok(out.banner.includes(`${leftover}, which may remain`), out.banner)
  assert.ok(out.context.includes(`${leftover}, which may remain`), out.context)
  assert.match(fs.readFileSync(w.handoff, 'utf8'), /A newer plan\./)
})

test('a rename that happened is archived and delivered even when the live path cannot be checked', async (t) => {
  const { w } = await announced(t)
  const original = fs.readFileSync(w.handoff)
  w.host.intercept.run = async (argv, real) => {
    if (argv[0] !== 'mv') return real()
    await real()
    throw new Error('mv was interrupted')
  }
  const exists = w.host.$.fs.exists
  w.host.$.fs.exists = async (file) => {
    if (file === w.handoff) throw new Error('a policy refused it')
    return exists(file)
  }
  const out = await w.prompt('go')
  w.host.$.fs.exists = exists
  const [archived] = w.archived()
  assert.deepEqual(fs.readFileSync(archived), original)
  assert.deepEqual(out.lines, [`Handoff archived to ${archived}`])
  assert.ok(out.context.includes(`It is now archived at ${archived}.`), out.context)
  assert.match(out.context, /Ship the widget\./)
})
