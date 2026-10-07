// The stand-in mods host must behave as the mods documentation says each call does, or the
// suites that use it prove nothing. One check per documented behaviour Torch relies on.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { createHost, cutUtf8 } from './host.mjs'

function world(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'torch-host-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, host: createHost({ env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, cwd: dir }) }
}

test('process.run starts in the session folder, takes stdin, and resolves any exit code', async (t) => {
  const { dir, host } = world(t)
  assert.equal((await host.$.process.run(['pwd'])).stdout.trim(), dir)
  assert.equal((await host.$.process.run(['cat'], { stdin: 'piped' })).stdout, 'piped')
  assert.equal((await host.$.process.run(['sh', '-c', 'exit 3'])).exitCode, 3)
  await assert.rejects(host.$.process.run(['no-such-program-torch']))
  await assert.rejects(host.$.process.run(['sleep', '5'], { timeoutMs: 100 }), /still running/)
})

test('process.run lays env over the host environment', async (t) => {
  const { host } = world(t)
  const out = await host.$.process.run(['sh', '-c', 'echo "$PATH|$EXTRA"'], { env: { EXTRA: 'x' } })
  assert.equal(out.stdout.trim(), `${process.env.PATH}|x`)
})

test('output is cut at 4 MiB without splitting a character', () => {
  const limit = 4 * 1024 * 1024
  const bytes = Buffer.concat([Buffer.alloc(limit - 1, 'a'), Buffer.from('é')])
  const text = cutUtf8(bytes, limit)
  assert.equal(text.length, limit - 1)
  assert.ok(!text.includes('�'))
})

test('fs.stat describes what a path leads to, and a link that leads nowhere', async (t) => {
  const { dir, host } = world(t)
  fs.writeFileSync(path.join(dir, 'f'), 'abc')
  fs.symlinkSync('f', path.join(dir, 'to-f'))
  fs.symlinkSync('gone', path.join(dir, 'to-gone'))
  assert.deepEqual(await host.$.fs.stat('f').then(({ kind, size, isLink }) => [kind, size, isLink]), ['file', 3, false])
  assert.deepEqual(await host.$.fs.stat('to-f').then(({ kind, isLink }) => [kind, isLink]), ['file', true])
  assert.deepEqual(await host.$.fs.stat('to-gone').then(({ kind, isLink }) => [kind, isLink]), ['other', true])
  assert.equal((await host.$.fs.stat('.')).kind, 'dir')
  await assert.rejects(host.$.fs.stat('missing'))
  assert.equal(await host.$.fs.exists('to-gone'), false, 'exists follows links')
})

test('fs.read and fs.write refuse more than 4 MiB', async (t) => {
  const { dir, host } = world(t)
  fs.writeFileSync(path.join(dir, 'big'), Buffer.alloc(4 * 1024 * 1024 + 1))
  await assert.rejects(host.$.fs.read('big'))
  await assert.rejects(host.$.fs.write('out', 'x'.repeat(4 * 1024 * 1024 + 1)))
  await host.$.fs.write('deep/er/file', 'ok')
  assert.equal(await host.$.fs.read('deep/er/file'), 'ok')
  assert.deepEqual(await host.$.fs.read('deep/er/file', { as: 'bytes' }), { base64: Buffer.from('ok').toString('base64') })
})

test('the store keeps JSON copies and refuses more than 4 MiB of JSON text', async (t) => {
  const { host } = world(t)
  const value = { a: [1, 'two'] }
  await host.$.store.set('k', value)
  value.a.push(3)
  assert.deepEqual(await host.$.store.get('k'), { a: [1, 'two'] })
  await assert.rejects(host.$.store.set('big', 'é'.repeat(2 * 1024 * 1024 + 10)), /4 MiB/)
  assert.deepEqual(await host.$.store.keys(), ['k'])
})

test('git runs with the repository\'s hooks off', async (t) => {
  const { dir, host } = world(t)
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1', HOME: dir }
  assert.equal((await host.$.process.run(['git', 'init', '-q'], { env })).exitCode, 0)
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\ntouch hook-ran\nexit 1\n')
  fs.chmodSync(hook, 0o755)
  const commit = await host.$.process.run(['git', 'commit', '-q', '--allow-empty', '-m', 'x'], { env })
  assert.equal(commit.exitCode, 0, commit.stderr)
  assert.ok(!fs.existsSync(path.join(dir, 'hook-ran')))
})

test('a .catch handler\'s next replays a call the hook made, and runs what is beneath once otherwise', async () => {
  const host = createHost()
  let runs = 0
  const core = async (e) => { runs += 1; return { text: e.text, n: runs } }
  host.on('late', async ($, e, next) => { await next(e); throw new Error('after next') })
    .catch(async ($, e, next) => { await next(e); return next(e) })
  host.on('early', async () => { throw new Error('before next') })
    .catch(async ($, e, next) => { await next(e); return next(e) })
  assert.deepEqual(await host.fire('late', { text: 'a' }, core), { text: 'a', n: 1 })
  assert.equal(runs, 1, 'nothing beneath ran again')
  assert.deepEqual(await host.fire('early', { text: 'b' }, core), { text: 'b', n: 2 })
  assert.equal(runs, 2, 'what is beneath ran once')
})

test('a .catch handler that answers undefined counts as the hook being absent', async () => {
  const host = createHost()
  let runs = 0
  const core = async (e) => { runs += 1; return { text: e.text } }
  host.on('early', async () => { throw new Error('before next') }).catch(async () => undefined)
  assert.deepEqual(await host.fire('early', { text: 'c' }, core), { text: 'c' })
  assert.equal(runs, 1)
})

test('a .catch handler runs only once a next call the hook made has settled', async () => {
  const host = createHost()
  const order = []
  let release
  const core = (e) => {
    order.push('core starts')
    return new Promise((resolve) => { release = () => { order.push('core settles'); resolve({ text: e.text }) } })
  }
  host.on('eager', async ($, e, next) => { next(e); throw new Error('right after next') })
    .catch(async ($, e, next) => { order.push('catch'); return next(e) })
  const fired = host.fire('eager', { text: 'd' }, core)
  await new Promise((resolve) => setImmediate(resolve))
  release()
  assert.deepEqual(await fired, { text: 'd' })
  assert.deepEqual(order, ['core starts', 'core settles', 'catch'])
})

