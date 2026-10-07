// Torch in Claude Code's own engine, through `claude plugin test`: the module loads, its hooks get
// the events and filters they should, the session start passes through untouched, the user's
// first message carries Torch's context down the prompt chain, and a refused call ends in a
// logged failure, never a blocked event. Every file and process call is answered here from an
// in-memory project, so what these tests prove is the wiring; tests/node checks the behaviour
// against a real file system and real git.
import { expect, test } from 'claude-code/testing'

const ROOT = '/work'
const HANDOFF = `${ROOT}/handoff-before-clear.md`
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const BOM = '﻿'

type Files = Map<string, string>

function startEvent(source: string) {
  return { session_id: SESSION, cwd: ROOT, source, hook_event_name: 'SessionStart', transcript_path: '/t.jsonl' }
}

function message(text: string, origin = 'composer', context?: string[]) {
  return { text, wait: false, origin: { kind: origin }, ...(context ? { context } : {}) }
}

// Stubs for every call Torch makes, over an in-memory project folder that is not a git repo.
function project(on: any, files: Files, { denyStat = false } = {}) {
  const store = new Map<string, unknown>()
  const logs: string[] = []
  const runs: string[][] = []
  const exists = (path: string) => files.has(path) || [...files.keys()].some((name) => name.startsWith(`${path}/`))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'CLAUDE_CODE_ENTRYPOINT' ? 'cli' : '1' }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: ROOT }))
  on('ui.log', ($: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($: any, e: any) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('fs.exists', ($: any, e: any) => ({ value: exists(e.path) }))
  on('fs.stat', ($: any, e: any) => (denyStat ? { deny: 'a policy mod refused it' } : {
    value: { kind: 'file', size: files.get(e.path)?.length ?? 0, mtimeMs: Date.now(), isLink: false },
  }))
  on('fs.read', ($: any, e: any) => {
    const bytes = new TextEncoder().encode(files.get(e.path) ?? '')
    return { value: { base64: btoa(String.fromCharCode(...bytes)) } }
  })
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    runs.push(argv)
    const ok = { exitCode: 0, stdout: '', stderr: '' }
    const fail = { exitCode: 1, stdout: '', stderr: `${argv[0]}: failed` }
    if (argv[0] === 'mkdir') return { value: ok }
    if (argv[0] === 'mv') {
      files.set(argv[3], files.get(argv[2]) as string)
      files.delete(argv[2])
      return { value: ok }
    }
    if (argv[0] === 'link') {
      if (files.has(argv[2])) return { value: fail }
      files.set(argv[2], files.get(argv[1]) as string)
      return { value: ok }
    }
    if (argv[0] === 'rm') {
      files.delete(argv[3])
      return { value: ok }
    }
    return { value: fail }
  })
  return { store, logs, runs }
}

const handoff = (body: string) => `---\nhandoff: 1\nsaved_at: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}\n`
  + `branch: main\nhead: none\n---\n# Handoff — test\n\n${body}\n`

test('only startup and clear announce the handoff', async ($, on) => {
  const files: Files = new Map([[HANDOFF, handoff('Ship it.')]])
  const world = project(on, files)
  on('classic.SessionStart', () => ({}))
  for (const source of ['resume', 'compact', 'fork']) await $.classic.SessionStart(startEvent(source))
  expect(world.logs).toEqual([])
  expect([...world.store.keys()]).toEqual([])
  await $.classic.SessionStart(startEvent('clear'))
  expect(world.logs[0]).toMatch(/^Handoff ready: /)
  expect([...world.store.keys()]).toEqual([`session:${SESSION}`])
})

test('the session start passes through untouched; the first message carries the handoff beside other context', async ($, on) => {
  const files: Files = new Map([[HANDOFF, `${BOM}${handoff('Ship the green widget.')}`]])
  const world = project(on, files)
  const settings = { additionalContext: ['from a settings hook'], sessionTitle: 'kept' }
  on('classic.SessionStart', () => settings)
  let carried: string[] | undefined
  on('prompt.submit', ($: any, e: any) => {
    carried = e.context
    return { text: e.text, context: e.context, origin: e.origin }
  })

  const start = await $.classic.SessionStart(startEvent('startup'))
  expect(start).toEqual(settings)
  expect(world.logs[0]).toMatch(/^Handoff ready: saved .* · not a git repo\. Claude gets it with your first message, which archives it\.$/)

  const first = await $.prompt.submit(message('carry on', 'composer', ['from a prompt hook']))
  expect(first.text).toBe('carry on')
  expect(carried?.[0]).toBe('from a prompt hook')
  expect(carried?.[1]).toContain('Ship the green widget.')
  expect(carried?.[1]).not.toContain(BOM)
  expect(carried?.[1]).toMatch(/It is now archived at \/work\/\.claude\/handoff-archive\/\d{8}T\d{6}Z\.md\./)
  expect(world.logs[1]).toMatch(/^Handoff archived to \/work\/\.claude\/handoff-archive\/\d{8}T\d{6}Z\.md$/)
  expect(files.has(HANDOFF)).toBe(false)
  expect([...world.store.keys()]).toEqual([])
})

test('a notification is not the first message; the user\'s next one is', async ($, on) => {
  const files: Files = new Map([[HANDOFF, handoff('Wait for the user.')]])
  const world = project(on, files)
  on('classic.SessionStart', () => ({}))
  const carried: (string[] | undefined)[] = []
  on('prompt.submit', ($: any, e: any) => {
    carried.push(e.context)
    return { text: e.text, context: e.context, origin: e.origin }
  })
  await $.classic.SessionStart(startEvent('startup'))
  await $.prompt.submit(message('a task finished', 'task-notification'))
  expect(carried[0]).toBeUndefined()
  expect(files.has(HANDOFF)).toBe(true)
  expect(world.runs).toEqual([])
  await $.prompt.submit(message('continue'))
  expect(carried[1]?.[0]).toContain('Wait for the user.')
  expect(files.has(HANDOFF)).toBe(false)
})

test('a later hook\'s refusal of the first message passes back untouched', async ($, on) => {
  const files: Files = new Map([[HANDOFF, handoff('Refused.')]])
  const world = project(on, files)
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', () => ({ drop: 'not now' }))
  await $.classic.SessionStart(startEvent('startup'))
  const refused = await $.prompt.submit(message('go'))
  expect(refused).toEqual({ drop: 'not now' })
  expect(world.logs[1]).toMatch(/^Handoff archived to /)
})

test('a refused call is logged and the session starts with the other hooks\' result', async ($, on) => {
  const files: Files = new Map([[HANDOFF, handoff('Unreachable.')]])
  const world = project(on, files, { denyStat: true })
  const settings = { additionalContext: ['other'] }
  on('classic.SessionStart', () => settings)
  const result = await $.classic.SessionStart(startEvent('startup'))
  expect(result).toEqual(settings)
  expect(world.logs.length).toBe(1)
  expect(world.logs[0]).toMatch(/^could not announce the handoff: .*a policy mod refused it/)
})
