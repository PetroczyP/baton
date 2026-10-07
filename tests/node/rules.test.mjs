// Torch's pure rules, case by case: the contract parser, git status parsing, ages, times, the
// inline budget and the texts. No files or processes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONTEXT_LIMIT, archiveStamp, contractFields, humanAge, loadedTexts, localTime, parseStatus,
} from '../../hooks/rules.mjs'

const HEAD40 = 'a'.repeat(40)
const block = (fields) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}\n`).join('')}---\n# Handoff\n`
const good = { handoff: '1', saved_at: '2026-10-06T14:54:32Z', branch: 'main', head: HEAD40 }

test('a valid contract parses, with its save time', () => {
  const fields = contractFields(block(good))
  assert.equal(fields.branch, 'main')
  assert.equal(fields.savedTs, Date.parse('2026-10-06T14:54:32Z') / 1000)
  assert.ok(contractFields(block({ ...good, head: 'b'.repeat(64) })), 'a 64-character head is valid')
  assert.ok(contractFields(block({ ...good, head: 'none' })))
  assert.ok(contractFields(block({ ...good, branch: '(detached)' })))
})

test('a contract that breaks a rule counts as absent', () => {
  const broken = {
    'unpadded fields (Δ12)': { ...good, saved_at: '2026-1-5T1:2:3Z' },
    'an extra key': { ...good, extra: 'x' },
    'a branch with a space': { ...good, branch: 'my branch' },
    'a branch with a backtick': { ...good, branch: 'main`' },
    "a branch with a single quote": { ...good, branch: "'main'" },
    'an uppercase head': { ...good, head: 'A'.repeat(40) },
    'a 41-character head': { ...good, head: 'a'.repeat(41) },
    'year zero': { ...good, saved_at: '0000-01-01T00:00:00Z' },
    'February 30': { ...good, saved_at: '2026-02-30T00:00:00Z' },
    'hour 24': { ...good, saved_at: '2026-10-06T24:00:00Z' },
    'a local time': { ...good, saved_at: '2026-10-06T14:54:32+02:00' },
  }
  for (const [label, fields] of Object.entries(broken)) assert.equal(contractFields(block(fields)), null, label)
  assert.equal(contractFields(`---\nhandoff: 1\n# Handoff\n`), null, 'an unterminated block')
  assert.equal(contractFields(`# Handoff\n---\n${block(good)}`), null, 'a block that is not first')
})

test('years 1 to 99 keep their value', () => {
  const fields = contractFields(block({ ...good, saved_at: '0099-01-01T00:00:00Z' }))
  assert.equal(new Date(fields.savedTs * 1000).getUTCFullYear(), 99)
})

test('git status lines count by kind, and the handoff call says whether it is tracked', () => {
  const tree = ['# branch.oid ' + HEAD40, '# branch.head main', '1 .M N... 100644 100644 100644 a b f1',
    '2 R. N... 100644 100644 100644 a b R100 f2\tf3', 'u UU N... 1 2 3 4 a b c f4', '? f5', '! f6', ''].join('\n')
  const facts = parseStatus(tree, '? handoff-before-clear.md\n')
  assert.deepEqual([facts.branch, facts.head, facts.changes, facts.handoffTracked], ['main', HEAD40, 4, false])
  assert.equal(parseStatus(tree, '! handoff-before-clear.md\n').handoffTracked, false)
  assert.equal(parseStatus(tree, '').handoffTracked, true, 'a clean tracked file prints nothing')
  assert.equal(parseStatus(tree, '1 .M N... 100644 100644 100644 a b handoff-before-clear.md\n').handoffTracked, true)
  assert.equal(parseStatus(tree, null).handoffTracked, null)
  assert.equal(parseStatus('# branch.oid (initial)\n# branch.head main\n', '').head, null)
  assert.equal(parseStatus(null, '').tree, false)
})

test('ages read in minutes, hours, then days', () => {
  const cases = [[-60, '0 min'], [0, '0 min'], [89 * 60, '89 min'], [90 * 60, '1 h'], [35 * 3600 + 3599, '35 h'],
    [36 * 3600, '1 d'], [20 * 86_400, '20 d']]
  for (const [seconds, text] of cases) assert.equal(humanAge(seconds), text, String(seconds))
})

test('local time names its zone; the archive stamp is UTC', () => {
  const saved = process.env.TZ
  process.env.TZ = 'UTC'
  try {
    assert.equal(localTime(0), '1970-01-01 00:00 UTC')
    process.env.TZ = 'Asia/Kolkata'
    assert.equal(localTime(0), '1970-01-01 05:30 GMT+5:30')
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
  assert.equal(archiveStamp(Date.parse('2026-10-06T14:54:32.900Z') / 1000), '20261006T145432Z')
})

test('a handoff is inlined up to 9,800 UTF-16 units of context, and pointed to above', () => {
  assert.equal(CONTEXT_LIMIT, 9_800)
  const facts = { handoff: '/p/handoff-before-clear.md', saved: 's', age: '1 min', drift: ['clean'], archiveTo: '/a.md', recorded: true }
  const base = loadedTexts({ ...facts, text: '' }).context.length
  const fits = loadedTexts({ ...facts, text: 'x'.repeat(9_800 - base) })
  assert.equal(fits.context.length, 9_800)
  assert.match(fits.context, /<handoff>/)
  const over = loadedTexts({ ...facts, text: 'x'.repeat(9_801 - base) })
  assert.doesNotMatch(over.context, /<handoff>/)
  assert.match(over.banner, /chars, Claude reads it from the file/)
})
