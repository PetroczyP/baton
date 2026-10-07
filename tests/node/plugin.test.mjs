// Torch as a plugin: what hooks.json declares, what the README promises, and what Anthropic's
// directory checks before it lists a plugin. Ported from v1's test_plugin.py.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { fixture, ROOT } from './support.mjs'

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

// The files the directory reads: what the repository tracks.
function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean).map((file) => path.join(ROOT, file))
}

test('hooks.json declares only the mod, and the plugin ships no scripts', () => {
  const config = JSON.parse(read('hooks/hooks.json'))
  assert.deepEqual(Object.keys(config).sort(), ['description', 'modules'])
  assert.deepEqual(config.modules, ['./torch.mjs'])
  assert.ok(fs.statSync(path.join(ROOT, 'hooks', 'torch.mjs')).isFile())
  const scripts = trackedFiles().filter((file) => /\.(sh|py)$/.test(file))
  assert.deepEqual(scripts, [])
})

test('the mod announces a handoff, then delivers and archives it with the first message', async (t) => {
  const w = await fixture(t)
  w.writeHandoff('# Handoff\n\nShip the green widget.\n')
  const start = await w.start()
  assert.match(start.banner, /^Handoff ready: /)
  const submit = await w.prompt('go')
  assert.match(submit.context, /Ship the green widget\./)
  assert.match(submit.banner, /^Handoff archived to /)
  assert.ok(!fs.existsSync(w.handoff))
  assert.deepEqual(await w.host.$.store.keys(), [])
})

test('the README quotes the instructions the mod gives Claude', async (t) => {
  const w = await fixture(t)
  w.writeHandoff('# Handoff\n\nAnything.\n')
  const { context } = await w.load()
  const guidance = context.split('How to use it:\n')[1].split('\n\n')[0].split('\n')
  assert.equal(guidance.length, 3, guidance.join('\n'))
  const readme = read('README.md')
  for (const line of guidance) assert.ok(readme.includes(`> ${line}\n`), line)
})

test('the manifest has the listing fields', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'))
  assert.equal(manifest.name, 'torch')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  for (const key of ['description', 'license', 'homepage', 'repository']) assert.ok(manifest[key], key)
  assert.ok(manifest.author.name)
  assert.ok(fs.statSync(path.join(ROOT, manifest.icon)).isFile())
  for (const key of ['homepage', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl']) {
    const address = new URL(manifest[key])
    assert.deepEqual([address.protocol, Boolean(address.host)], ['https:', true], key)
  }
})

test('license and README', () => {
  assert.ok(fs.statSync(path.join(ROOT, 'LICENSE')).isFile())
  const prose = read('README.md').replace(/```[\s\S]*?```/g, '')
  assert.ok(prose.split(/\s+/).filter(Boolean).length >= 40)
})

test('each skill has parseable front matter', () => {
  for (const skill of fs.readdirSync(path.join(ROOT, 'skills')).sort()) {
    const lines = read(path.join('skills', skill, 'SKILL.md')).split('\n')
    assert.equal(lines[0], '---', skill)
    const end = lines.indexOf('---', 1)
    assert.ok(end > 1, `${skill}: the front matter has no closing ---`)
    const fields = Object.fromEntries(lines.slice(1, end).map((line) => {
      const at = line.indexOf(': ')
      assert.ok(at > 0, `${skill}: not a "key: value" line: ${line}`)
      return [line.slice(0, at), line.slice(at + 2)]
    }))
    assert.equal(fields.name, skill)
    assert.ok(fields.description.trim())
  }
})

test('no system files or oversized files', () => {
  for (const file of trackedFiles()) {
    assert.ok(!['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(path.basename(file)), file)
    assert.ok(fs.statSync(file).size < 256 * 1024, file)
  }
})

// The directory reads the module without running it (spec R17, R18). These read it the same way.
const source = read('hooks/torch.mjs')

function functionBody(name) {
  const start = source.indexOf(`export async function ${name}(`)
  assert.ok(start >= 0, name)
  return source.slice(start, source.indexOf('\n}\n', start))
}

test('each hook ends in a shape the directory reads', () => {
  const returns = (name) => functionBody(name).split('\n').map((line) => line.trim()).filter((line) => line.startsWith('return'))
  assert.deepEqual(returns('announceHandoff'), ['return next(e)'])
  assert.deepEqual(returns('deliverHandoff'), [
    'return next(e)',
    'return next({ ...e, context: [...(e.context ?? []), context] })',
  ])
  assert.doesNotMatch(source, /classic\.UserPromptSubmit/)
})

test('next is never handed to other code, and each .catch handler ends in return next(e)', () => {
  const code = source.replace(/\/\/.*$/gm, '')
  for (const match of code.matchAll(/\bnext\b/g)) {
    const before = code.slice(match.index - 7, match.index)
    const after = code.slice(match.index + 4, match.index + 12)
    const allowed = before === '($, e, ' || after.startsWith('(e)') || after.startsWith('({ ...e,') || after.startsWith('.error')
    assert.ok(allowed, `next used as: ${code.slice(match.index - 30, match.index + 30).replace(/\s+/g, ' ')}`)
  }
  const handlers = [...code.matchAll(/\.catch\(async \(\$, e, next\) => \{([\s\S]*?)\n {4}\}\)/g)].map((m) => m[1])
  assert.equal(handlers.length, 2, 'one inline handler per hook')
  for (const body of handlers) {
    const returns = body.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('return'))
    assert.deepEqual(returns, ['return next(e)'])
  }
})

// The arguments of each $.process.run call, up to its closing parenthesis.
function processRunCalls() {
  const calls = []
  for (let at = source.indexOf('$.process.run('); at >= 0; at = source.indexOf('$.process.run(', at + 1)) {
    let depth = 0
    let end = at + '$.process.run'.length
    do {
      if (source[end] === '(') depth += 1
      if (source[end] === ')') depth -= 1
      end += 1
    } while (depth > 0)
    calls.push(source.slice(at, end))
  }
  return calls
}

test('no program the mod runs gets standard input', () => {
  const calls = processRunCalls()
  assert.equal(calls.length, 6)
  for (const call of calls) assert.doesNotMatch(call, /stdin/, call)
})

test('the README lists every command the mod runs, as it runs it', () => {
  const readme = read('README.md').replaceAll("'", '')
  const calls = [...source.matchAll(/\$\.process\.run\(\[([^\]]*)\]/g)].map((m) => m[1])
  assert.ok(calls.length >= 6, `${calls.length} calls`)
  for (const call of calls) {
    const tokens = [...call.matchAll(/'([^']*)'|([A-Za-z_$][\w$]*)/g)]
      .map(([, literal, name]) => (literal !== undefined
        ? literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '<[^>]+>'))
    const pattern = new RegExp(tokens.join('\\s+'))
    assert.match(readme, pattern, `README lacks: ${call.replace(/\s+/g, ' ')}`)
  }
})
