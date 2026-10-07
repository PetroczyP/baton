// A handoff saved by another session while this one archives must never be lost, and wherever
// the archive stops, the file's location is known, and only the announced handoff is delivered. Ported from v1's ArchiveRaceTests: where v1
// replaced os.rename or os.link, these intercept the `mv` or `link` the mod runs.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { archive } from '../../hooks/torch.mjs'
import { fixture, SESSION } from './support.mjs'

const LOADED = Buffer.from('# Handoff\nthe one this session loaded\n')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const ran = (exitCode, stderr = '') => ({ exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })

async function setup(t) {
  const w = await fixture(t)
  const dest = path.join(w.archiveDir, '20260101T000000Z.md')
  const claims = () => fs.readdirSync(w.repo).filter((name) => name.startsWith('.handoff-claim-'))
    .map((name) => path.join(w.repo, name))
  return { w, live: w.handoff, dest, claims }
}

const noLinks = (argv, real) => (argv[0] === 'link'
  ? Promise.resolve(ran(1, 'link: Operation not permitted')) : real())

test('a save landing before the claim is given back', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, '# Handoff\nnewer\n')
  const { outcome, place } = await archive(w.host.$, live, sha(LOADED), dest)
  assert.deepEqual([outcome, place], ['changed', null])
  assert.equal(fs.readFileSync(live, 'utf8'), '# Handoff\nnewer\n')
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), [])
  assert.deepEqual(claims(), [])
})

test('a save landing right after the claim stays live', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, '# Handoff\nintermediate\n')
  w.host.intercept.run = async (argv, real) => {
    const done = await real()
    if (argv[0] === 'mv') fs.writeFileSync(live, '# Handoff\nnewest\n')
    return done
  }
  const { outcome, place } = await archive(w.host.$, live, sha(LOADED), dest)
  assert.equal(outcome, 'changed')
  assert.equal(fs.readFileSync(live, 'utf8'), '# Handoff\nnewest\n')
  assert.equal(fs.readFileSync(place, 'utf8'), '# Handoff\nintermediate\n')
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), [path.basename(place)])
  assert.deepEqual(claims(), [])
})

test('a save still being written lands in the live file', async (t) => {
  const { w, live, dest } = await setup(t)
  fs.writeFileSync(live, LOADED)
  const writer = fs.openSync(live, 'r+')
  fs.ftruncateSync(writer, 0)
  try {
    const { outcome } = await archive(w.host.$, live, sha(LOADED), dest)
    fs.writeSync(writer, '# Handoff\nthe new save\n')
    assert.equal(outcome, 'changed')
  } finally {
    fs.closeSync(writer)
  }
  assert.equal(fs.readFileSync(live, 'utf8'), '# Handoff\nthe new save\n')
})

test('the claim is a rename beside the live file', async (t) => {
  const { w, live, dest } = await setup(t)
  fs.writeFileSync(live, LOADED)
  const moves = []
  w.host.intercept.run = (argv, real) => {
    if (argv[0] === 'mv') moves.push(argv)
    return real()
  }
  await archive(w.host.$, live, sha(LOADED), dest)
  assert.equal(moves.length, 1)
  const [, , from, to] = moves[0]
  assert.equal(from, live)
  assert.equal(path.dirname(to), path.dirname(live))
  assert.match(path.basename(to), /^\.handoff-claim-[0-9a-f]{32}\.md$/)
})

test('without hard links the claimed handoff is kept beside the live file', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, LOADED)
  w.host.intercept.run = noLinks
  const { outcome, place } = await archive(w.host.$, live, sha(LOADED), dest)
  assert.equal(outcome, 'kept')
  assert.deepEqual(claims(), [place])
  assert.deepEqual(fs.readFileSync(place), LOADED)
  assert.ok(!fs.existsSync(live))
})

test('a link that cannot run keeps the claim, as no hard links would', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, LOADED)
  w.host.intercept.run = (argv, real) => (argv[0] === 'link'
    ? Promise.reject(new Error('link: command not found')) : real())
  const { outcome, place } = await archive(w.host.$, live, sha(LOADED), dest)
  assert.equal(outcome, 'kept')
  assert.deepEqual(claims(), [place])
})

test('a rejected link at a taken name moves on to the next name', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, LOADED)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, 'an older archive')
  w.host.intercept.run = (argv, real) => (argv[0] === 'link' && argv[2] === dest
    ? Promise.reject(new Error('link was interrupted')) : real())
  const { outcome, place } = await archive(w.host.$, live, sha(LOADED), dest)
  assert.equal(outcome, 'archived')
  assert.equal(path.basename(place), '20260101T000000Z-2.md')
  assert.equal(fs.readFileSync(dest, 'utf8'), 'an older archive')
  assert.deepEqual(claims(), [])
})

test('an archive name that is a folder is skipped, never linked into', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, LOADED)
  fs.mkdirSync(dest, { recursive: true })
  const { outcome, place } = await archive(w.host.$, live, sha(LOADED), dest)
  assert.equal(outcome, 'archived')
  assert.equal(path.basename(place), '20260101T000000Z-2.md')
  assert.deepEqual(fs.readdirSync(dest), [])
  assert.deepEqual(fs.readFileSync(place), LOADED)
  assert.deepEqual(claims(), [])
})

test('a claim that cannot be removed is named, and the archive stands', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, LOADED)
  w.host.intercept.run = (argv, real) => (argv[0] === 'rm' ? Promise.resolve(ran(1, 'rm: denied')) : real())
  const result = await archive(w.host.$, live, sha(LOADED), dest)
  assert.deepEqual([result.outcome, result.place], ['archived', dest])
  assert.deepEqual(claims(), [result.leftover])
  assert.deepEqual(fs.readFileSync(dest), LOADED)
})

test('a failure before the claim leaves the handoff in place', async (t) => {
  for (const tool of ['mkdir', 'mv']) {
    await t.test(tool, async (st) => {
      const { w, live, dest, claims } = await setup(st)
      fs.writeFileSync(live, LOADED)
      w.host.intercept.run = (argv, real) => (argv[0] === tool
        ? Promise.reject(new Error(`${tool}: command not found`)) : real())
      await assert.rejects(archive(w.host.$, live, sha(LOADED), dest), new RegExp(tool))
      assert.deepEqual(fs.readFileSync(live), LOADED)
      assert.deepEqual(claims(), [])
    })
  }
})

test('a rename that happened although mv failed continues as a claim', async (t) => {
  for (const [label, after] of [['non-zero exit', (done) => ({ ...done, exitCode: 1 })],
    ['rejected call', () => { throw new Error('mv was still running after 30000 ms') }]]) {
    await t.test(label, async (st) => {
      const { w, live, dest, claims } = await setup(st)
      fs.writeFileSync(live, LOADED)
      w.host.intercept.run = async (argv, real) => {
        const done = await real()
        return argv[0] === 'mv' ? after(done) : done
      }
      const { outcome, place } = await archive(w.host.$, live, sha(LOADED), dest)
      assert.deepEqual([outcome, place], ['archived', dest])
      assert.deepEqual(fs.readFileSync(dest), LOADED)
      assert.deepEqual(claims(), [])
    })
  }
})

test('a failed mv with the handoff still in place leaves it untouched', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, LOADED)
  w.host.intercept.run = (argv, real) => (argv[0] === 'mv' ? Promise.resolve(ran(1, 'mv: denied')) : real())
  await assert.rejects(archive(w.host.$, live, sha(LOADED), dest), /mv could not claim .*mv: denied/)
  assert.deepEqual(fs.readFileSync(live), LOADED)
  assert.deepEqual(claims(), [])
})

async function submitWithoutHardLinks(w, live, dest, claims) {
  w.host.session.id = SESSION
  await w.host.$.store.set(`session:${SESSION}`, {
    handoff: live, sha256: sha(LOADED), archiveTo: dest, savedTs: Date.now() / 1000, drift: ['not a git repo'], at: Date.now(),
  })
  const runs = w.host.intercept.run
  w.host.intercept.run = (argv, real) => noLinks(argv, () => (runs ? runs(argv, real) : real()))
  const out = await w.prompt('go')
  const [kept] = claims()
  assert.ok(out.banner.includes(kept), out.banner)
  return { kept, context: out.context }
}

test('without hard links the model is told where the handoff is', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, LOADED)
  const { kept, context } = await submitWithoutHardLinks(w, live, dest, claims)
  assert.ok(context.includes(`It could not be archived and is now at ${kept}.`), context)
  assert.match(context, /the one this session loaded/, 'the kept handoff is the announced one, so it is delivered')
})

test('without hard links an unreadable handoff is not identified', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, LOADED)
  w.host.intercept.read = (file, real) => {
    if (path.basename(file).startsWith('.handoff-claim-')) throw new Error('permission denied')
    return real()
  }
  const { kept, context } = await submitWithoutHardLinks(w, live, dest, claims)
  assert.deepEqual(fs.readFileSync(kept), LOADED)
  assert.match(context, /^No handoff was delivered with this message\./)
  assert.match(context, /it is unknown whether it is the one announced/)
  assert.doesNotMatch(context, /It is not the handoff announced/)
  assert.doesNotMatch(context, /the one this session loaded/, 'an unread file is not delivered')
})

test('without hard links a later save is not passed off as the loaded one', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, '# Handoff\nsaved by another session\n')
  const { kept, context } = await submitWithoutHardLinks(w, live, dest, claims)
  assert.equal(fs.readFileSync(kept, 'utf8'), '# Handoff\nsaved by another session\n')
  assert.match(context, /^No handoff was delivered with this message\./)
  assert.match(context, /It is not the handoff announced at session start/)
  assert.doesNotMatch(context, /saved by another session/, 'a later save is not delivered')
})

test('the loaded handoff is archived and nothing else remains', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, LOADED)
  const { outcome, place } = await archive(w.host.$, live, sha(LOADED), dest)
  assert.deepEqual([outcome, place], ['archived', dest])
  assert.ok(!fs.existsSync(live))
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), [path.basename(dest)])
  assert.deepEqual(claims(), [])
})

test('a handoff gone before the claim is reported as gone', async (t) => {
  const { w, live, dest } = await setup(t)
  const { outcome, place } = await archive(w.host.$, live, sha(LOADED), dest)
  assert.deepEqual([outcome, place], ['gone', null])
})

test('a newer save already back at the live path is not replaced', async (t) => {
  const { w, live, dest, claims } = await setup(t)
  fs.writeFileSync(live, '# Handoff\nintermediate\n')
  w.host.intercept.run = async (argv, real) => {
    const done = await real()
    if (argv[0] === 'mv') fs.writeFileSync(live, '# Handoff\nnewest\n')
    return done
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, 'an older archive')
  const { outcome, place } = await archive(w.host.$, live, sha(LOADED), dest)
  assert.equal(outcome, 'changed')
  assert.equal(fs.readFileSync(dest, 'utf8'), 'an older archive')
  assert.equal(path.basename(place), '20260101T000000Z-2.md')
  assert.equal(fs.readFileSync(live, 'utf8'), '# Handoff\nnewest\n')
  assert.deepEqual(claims(), [])
})
