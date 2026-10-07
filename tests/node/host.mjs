// A stand-in for the Claude Code mods host, for Torch's node:test suites.
//
// It loads a hooks module the way Claude Code does (register(on)), fires classic.* events
// through the registered hooks as a middleware chain, and gives each hook a `$` with only
// the calls Torch makes. Every call runs on the real file system and real processes, with
// the semantics the mods documentation gives (rows of the v2 spec's section 2 in brackets):
//
//   $.fs.read      rejects a missing file or one over 4 MiB; { as: 'bytes' } gives { base64 }  [F10]
//   $.fs.write     creates the file and its directories; rejects text over 4 MiB              [F10]
//   $.fs.exists    follows symbolic links                                                     [F10]
//   $.fs.stat      { kind: 'file' | 'dir' | 'other', size, mtimeMs, isLink } of what the path
//                  leads to; a link that leads nowhere is `other` described by the link itself;
//                  rejects ENOENT                                                             [F10]
//   $.process.run  argv, no shell; cwd the session's unless given; init.env laid over the
//                  host's environment; init.stdin written then closed; git with repo hooks
//                  off; resolves any exit code, each stream cut to its first 4 MiB (a cut
//                  character dropped) with isStdoutTruncated / isStderrTruncated; a signal
//                  reads as exit code 1; rejects when the program cannot start or runs past
//                  timeoutMs                                                                  [F11]
//   $.store        an in-memory key-value store of JSON copies, at most 4 MiB of JSON text    [F12]
//   $.env.get      reads this host's environment, not the test process's                     [F13]
//   $.ui.log       collected in `logs`                                                        [F14]
//   $.session      id() and cwd(): the session the host currently runs, which a test sets with
//                  `host.session = { id, cwd }`; at prompt.submit, id() is the id the session
//                  started with, including the new one after /clear                            [F20]
//
// TORCH_TEST_TIMEOUT_SCALE (default 1) multiplies every process timeout, for a machine too loaded
// to run git within Torch's 5 s; a mutation run sets it so a slow git is not read as a kill.
//
// Tests can intercept a call with `intercept.run(argv, real)`, `intercept.read(path, real)`,
// which replace the real call for the arguments they choose, as the v1 tests replaced os.rename
// or os.link. The real engine's event shapes and result merging are checked separately by the
// claude plugin test suite (tests/torch.test.ts), against Claude Code itself.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const READ_LIMIT = 4 * 1024 * 1024
const OUTPUT_LIMIT = 4 * 1024 * 1024
const STORE_LIMIT = 4 * 1024 * 1024
const TIMEOUT_SCALE = Number(process.env.TORCH_TEST_TIMEOUT_SCALE ?? 1)

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function matches(filter, e) {
  if (!filter) return true
  return Object.entries(filter).every(([key, want]) => {
    const have = e[key]
    if (Array.isArray(want)) return want.includes(have)
    if (want instanceof RegExp) return typeof have === 'string' && want.test(have)
    return have === want
  })
}

// The first `limit` bytes of UTF-8 output as text, without a character the cut split.
export function cutUtf8(bytes, limit) {
  if (bytes.length <= limit) return bytes.toString('utf8')
  let end = limit
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function runReal(argv, init, env) {
  const args = argv[0] === 'git' ? ['-c', 'core.hooksPath=/dev/null', ...argv.slice(1)] : argv.slice(1)
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(argv[0], args, { cwd: init.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    // A child that exits without reading its input closes the pipe first: EPIPE is not a failure.
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error) })
    child.stdin.end(init.stdin ?? '')
    const out = { stdout: [], stderr: [] }
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`${argv[0]} was still running after ${init.timeoutMs} ms`))
    }, (init.timeoutMs ?? 30_000) * TIMEOUT_SCALE)
    child.stdout.on('data', (chunk) => { out.stdout.push(chunk) })
    child.stderr.on('data', (chunk) => { out.stderr.push(chunk) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = Buffer.concat(out.stdout)
      const stderr = Buffer.concat(out.stderr)
      resolve({
        exitCode: code ?? 1,
        stdout: cutUtf8(stdout, OUTPUT_LIMIT),
        stderr: cutUtf8(stderr, OUTPUT_LIMIT),
        isStdoutTruncated: stdout.length > OUTPUT_LIMIT,
        isStderrTruncated: stderr.length > OUTPUT_LIMIT,
      })
    })
  })
}

let loads = 0

export function createHost({ env = {}, cwd = process.cwd(), intercept = {} } = {}) {
  let currentEnv = env
  const session = { id: undefined, cwd }
  const hooks = []
  const store = new Map()
  const logs = []

  const realRead = (file, options) => {
    const stat = fs.statSync(file)
    if (stat.size > READ_LIMIT) throw new Error(`${file} is over 4 MiB`)
    const bytes = fs.readFileSync(file)
    return options?.as === 'bytes' ? { base64: bytes.toString('base64') } : bytes.toString('utf8')
  }
  const realRun = (argv, init = {}) => runReal(argv, { ...init, cwd: absolute(init.cwd ?? '.') },
    { ...currentEnv, ...(init.env ?? {}) })
  const absolute = (file) => path.resolve(cwd, file)

  const $ = {
    fs: {
      read: async (file, options) => (intercept.read
        ? intercept.read(absolute(file), () => realRead(absolute(file), options), options)
        : realRead(absolute(file), options)),
      write: async (file, text) => {
        if (Buffer.byteLength(text) > READ_LIMIT) throw new Error(`writing ${file} would be over 4 MiB`)
        fs.mkdirSync(path.dirname(absolute(file)), { recursive: true })
        fs.writeFileSync(absolute(file), text)
      },
      exists: async (file) => fs.existsSync(absolute(file)),
      stat: async (file) => {
        const own = fs.lstatSync(absolute(file))
        const target = own.isSymbolicLink() ? (fs.statSync(absolute(file), { throwIfNoEntry: false }) ?? null) : own
        if (target === null) return { kind: 'other', size: own.size, mtimeMs: own.mtimeMs, isLink: true }
        const kind = target.isFile() ? 'file' : target.isDirectory() ? 'dir' : 'other'
        return { kind, size: target.size, mtimeMs: target.mtimeMs, isLink: own.isSymbolicLink() }
      },
    },
    process: {
      run: async (argv, init = {}) => {
        if (!Array.isArray(argv) || argv.length === 0) throw new Error('argv must be a non-empty array')
        return intercept.run ? intercept.run(argv, () => realRun(argv, init), init) : realRun(argv, init)
      },
    },
    store: {
      get: async (key) => (store.has(key) ? JSON.parse(store.get(key)) : undefined),
      set: async (key, value) => {
        const next = new Map(store).set(key, JSON.stringify(value))
        const size = Buffer.byteLength(JSON.stringify(Object.fromEntries([...next].map(([k, v]) => [k, JSON.parse(v)]))))
        if (size > STORE_LIMIT) throw new Error('the store would exceed 4 MiB')
        store.set(key, JSON.stringify(value))
      },
      delete: async (key) => { store.delete(key) },
      keys: async () => [...store.keys()],
    },
    env: {
      get: async (name) => currentEnv[name],
    },
    ui: {
      log: (text) => { logs.push(text) },
    },
    session: {
      id: async () => session.id,
      cwd: async () => session.cwd,
    },
  }

  function on(event, filterOrHook, maybeHook) {
    const entry = typeof filterOrHook === 'function'
      ? { event, filter: undefined, hook: filterOrHook, onError: undefined }
      : { event, filter: filterOrHook, hook: maybeHook, onError: undefined }
    hooks.push(entry)
    return { catch(handler) { entry.onError = handler } }
  }

  // Fire an event through every hook registered for it, in registration order, ending in
  // `core`, which stands for Claude Code's own behaviour and the settings hooks beneath the
  // mods. A hook that fails is handed to its .catch handler, as the engine does [F23]. There
  // `next` is replay-safe: after the hook's own call it settles as that call did, with nothing
  // beneath running again; before, it runs the hooks beneath once and a later call replays that.
  // The handler's answer is the hook's result, and undefined counts as the hook being absent.
  async function fire(event, e, core) {
    core ??= async () => ({})
    const chain = hooks.filter((entry) => entry.event === event && matches(entry.filter, e))
    const dispatch = async (index, input) => {
      if (index === chain.length) return core(input)
      const { hook, onError } = chain[index]
      let last
      const next = (passed) => {
        last = dispatch(index + 1, passed)
        return last
      }
      try {
        return await hook($, input, next)
      } catch (error) {
        // The handler runs once a call the hook made has settled, whichever way.
        if (last !== undefined) await Promise.allSettled([last])
        const called = last !== undefined
        if (!onError) return called ? last : dispatch(index + 1, input)
        let replay = last
        const handlerNext = (passed) => {
          replay ??= dispatch(index + 1, passed)
          return replay
        }
        handlerNext.error = { kind: 'throw', message: error instanceof Error ? error.message : String(error) }
        handlerNext.called = called
        const answer = await onError($, input, handlerNext)
        return answer === undefined ? handlerNext(input) : answer
      }
    }
    return dispatch(0, deepFreeze(structuredClone(e)))
  }

  // Each host loads its own instance of the module, as each Claude Code process does, so state the
  // module keeps for its life starts empty in every test.
  async function load(modulePath) {
    loads += 1
    const module = await import(`${pathToFileURL(modulePath).href}?host=${loads}`)
    module.register(on, {})
  }

  // A new instance of the module in place of the current one, with the same store: what
  // `/reload-plugins` does, and what a new Claude Code process resuming a session finds.
  async function reload(modulePath) {
    hooks.length = 0
    await load(modulePath)
  }

  // Run `body` with the host's environment replaced, as one hook run in v1 got its own env.
  async function withEnv(replacement, body) {
    const saved = currentEnv
    currentEnv = replacement
    try {
      return await body()
    } finally {
      currentEnv = saved
    }
  }

  return { $, on, fire, load, reload, withEnv, store, logs, intercept, session, get env() { return currentEnv } }
}
