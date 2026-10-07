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

test('a command that only starts like load-handoff is a first message like any other', async (t) => {
  for (const command of ['/load-handoff-extra', '/torch:load-handoffs', '/torch:load-handoff-now']) {
    await t.test(command, async (st) => {
      const { w } = await loaded(st)
      await w.prompt(command)
      assert.ok(!fs.existsSync(w.handoff))
      assert.equal(w.archived().length, 1)
    })
  }
})

test('a successful load and archive add context and nothing else', async (t) => {
  const w = await fixture(t)
  const sha = w.initRepo()
  w.writeHandoff(handoffText({ head: sha }))
  const load = await w.start()
  assert.match(load.context, /Ship the widget\./)
  assert.deepEqual(Object.keys(load.result), ['additionalContext'])
  const first = await w.prompt('go')
  assert.match(first.banner, /^Handoff archived to /)
  assert.deepEqual(Object.keys(first.result), ['additionalContext'])
})

test("one session's prompt never touches another session's record or handoff", async (t) => {
  const { w } = await loaded(t)
  const other = '33333333-0000-0000-0000-000000000000'
  const out = await w.prompt('go', { session: other })
  assert.deepEqual([out.banner, out.context], ['', ''])
  assert.ok(fs.existsSync(w.handoff))
  assert.deepEqual(await w.host.$.store.keys(), [`session:${SESSION}`])
})

test('a blocked first prompt with an empty reason still leaves the handoff', async (t) => {
  const { w } = await loaded(t)
  const blocked = await w.host.fire('classic.UserPromptSubmit', {
    session_id: SESSION, cwd: w.repo, hook_event_name: 'UserPromptSubmit', prompt: 'go',
  }, async () => ({ block: '' }))
  assert.deepEqual(blocked, { block: '' })
  assert.ok(fs.existsSync(w.handoff))
  assert.deepEqual(await w.host.$.store.keys(), [`session:${SESSION}`])
})

test('a prompt from a folder that is not a POSIX path touches nothing', async (t) => {
  const { w } = await loaded(t)
  const runs = []
  w.host.intercept.run = (argv, real) => { runs.push(argv[0]); return real() }
  const store = w.host.$.store
  const reads = []
  w.host.$.store = Object.fromEntries(Object.entries(store).map(([name, call]) => [name, (...args) => {
    reads.push(name)
    return call(...args)
  }]))
  const out = await w.fire('classic.UserPromptSubmit', {
    session_id: SESSION, cwd: 'C:\\work', hook_event_name: 'UserPromptSubmit', prompt: 'go',
  })
  w.host.$.store = store
  assert.deepEqual([out.lines, out.context, runs, reads], [[], '', [], []])
  assert.deepEqual(await w.host.$.store.keys(), [`session:${SESSION}`])
  assert.ok(fs.existsSync(w.handoff))
})

test('after a failed archive the session tries no more, and the prompt runs once', async (t) => {
  const { w } = await loaded(t)
  w.host.intercept.run = (argv, real) => (argv[0] === 'mkdir' ? Promise.reject(new Error('mkdir: denied')) : real())
  let downstream = 0
  const fire = () => w.host.fire('classic.UserPromptSubmit', {
    session_id: SESSION, cwd: w.repo, hook_event_name: 'UserPromptSubmit', prompt: 'go',
  }, async () => { downstream += 1; return {} })
  await fire()
  assert.equal(downstream, 1)
  assert.equal(w.host.logs.at(-1), 'could not archive the handoff: mkdir: denied')
  const logged = w.host.logs.length
  await fire()
  assert.equal(downstream, 2)
  assert.equal(w.host.logs.length, logged, 'the second prompt logs nothing')
  assert.ok(fs.existsSync(w.handoff))
})

test('when it cannot be told whether a link was made, the claim is kept and named', async (t) => {
  const { w } = await loaded(t)
  const original = fs.readFileSync(w.handoff)
  w.host.intercept.run = (argv, real) => (argv[0] === 'link'
    ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'link: failed', isStdoutTruncated: false, isStderrTruncated: false })
    : real())
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
  assert.ok(out.context.includes(kept), out.context)
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
      const { w } = await loaded(st)
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
  const { w } = await loaded(t)
  fs.writeFileSync(w.handoff, handoffText({ body: 'A newer plan.' }))
  w.host.intercept.run = async (argv, real) => (argv[0] === 'rm'
    ? { exitCode: 1, stdout: '', stderr: 'rm: denied', isStdoutTruncated: false, isStderrTruncated: false }
    : real())
  const out = await w.prompt('go')
  const [claim] = fs.readdirSync(w.repo).filter((name) => name.startsWith('.handoff-claim-'))
  const leftover = path.join(w.repo, claim)
  assert.match(out.banner, /changed after it was loaded/)
  assert.ok(out.banner.includes(`${leftover}, which may remain`), out.banner)
  assert.ok(out.context.includes(`${leftover}, which may remain`), out.context)
  assert.match(fs.readFileSync(w.handoff, 'utf8'), /A newer plan\./)
})

test('a rename that happened is archived even when the live path cannot be checked', async (t) => {
  const { w } = await loaded(t)
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
  assert.ok(out.context.includes(archived))
})
