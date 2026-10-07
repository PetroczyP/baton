// Torch, a Claude Code mod: finds the project's handoff-before-clear.md when a new interactive
// session starts, gives it to Claude with the user's first message, and moves it into
// .claude/handoff-archive/ at that moment, so the next session starts fresh.
//
//   classic.SessionStart (startup, clear)  checks the handoff, records it for this session and
//                                          logs a one-line banner with the git drift since the
//                                          save; it passes the event on unchanged
//   prompt.submit                          on the session's first message from the user,
//                                          archives the handoff and attaches it to that message
//                                          as context, unless the message is /torch:load-handoff
//
// Every function that is handed `$` is declared in this file, as `claude plugin validate`
// requires; rules.mjs holds the rules that need no file or process access. Torch never answers
// or blocks an event: each hook ends in `next(e)` or `next({ ...e, context })`, and a failure is
// logged while the event goes on.
import {
  ARCHIVE_DIR, HANDOFF_NAME, MAX_AGE_DAYS, READ_LIMIT, RECORD_MAX_AGE_DAYS, REFUSALS,
  ancestors, announcedBanner, archiveStamp, base64ToBytes, contractFields, deliveredTexts,
  driftParts, hasTitle, humanAge, isOtherHost, isRecord, joinPath, localTime, parentPath,
  parseStatus, randomHex, sha256Hex, usableSessionId,
} from './rules.mjs'

const GIT_TIMEOUT_MS = 5_000
const CLAIM_PREFIX = '.handoff-claim-'
const RECORD_PREFIX = 'session:'
const LOAD_SKILL = /^\s*\/(?:torch:)?load-handoff(\s|$)/
const USER_ORIGINS = new Set(['composer', 'bridge'])

// Sessions that have had their first message from the user, kept for the life of the module. A
// message of a session already here passes on unchanged, whether it overlaps the first or comes
// after a first message whose record could not be deleted, so a session acts at most once.
const answered = new Set()

export function register(on) {
  on('classic.SessionStart', { source: ['startup', 'clear'] }, announceHandoff)
    .catch(($, e, next) => reportFailure($, 'announce', e, next))
  on('prompt.submit', deliverHandoff)
    .catch(($, e, next) => reportFailure($, 'deliver', e, next))
}

// A failed hook is logged, and the event continues: with the result `next` already gave, or
// by calling it now.
export async function reportFailure($, verb, e, next) {
  $.ui.log(`could not ${verb} the handoff: ${next.error?.message ?? 'unknown error'}`)
  return next.called ? undefined : next(e)
}

export async function announceHandoff($, e, next) {
  await announce($, e)
  return next(e)
}

export async function deliverHandoff($, e, next) {
  const context = await firstMessageContext($, e)
  if (context === null) {
    return next(e)
  }
  return next({ ...e, context: [...(e.context ?? []), context] })
}

// Check this session's handoff, record it for the first message and log the banner; refusals are
// logged as banners too.
async function announce($, e) {
  if (await isSkippedSession($)) return
  const cwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : await $.session.cwd()
  if (!cwd.startsWith('/')) {
    $.ui.log(REFUSALS.platform)
    return
  }
  await removeStaleRecords($)
  const { root, isRepo } = await projectRoot($, cwd)
  const handoff = joinPath(root, HANDOFF_NAME)
  const stat = (await $.fs.exists(handoff)) ? await $.fs.stat(handoff) : await brokenLink($, handoff)
  if (stat === null) return
  if (stat.isLink) {
    $.ui.log(REFUSALS.symlink)
    return
  }
  if (stat.kind !== 'file') return
  if (stat.size > READ_LIMIT) {
    $.ui.log(REFUSALS.tooLarge)
    return
  }

  const bytes = await readBytes($, handoff)
  const text = new TextDecoder().decode(bytes)
  if (!hasTitle(text)) {
    $.ui.log(REFUSALS.untitled)
    return
  }
  const fields = contractFields(text)
  const savedTs = fields ? fields.savedTs : stat.mtimeMs / 1000
  const ageSeconds = Date.now() / 1000 - savedTs
  const saved = localTime(savedTs)
  const age = humanAge(ageSeconds)
  if (ageSeconds > MAX_AGE_DAYS * 86_400) {
    $.ui.log(REFUSALS.old(saved, age))
    return
  }

  const status = isRepo ? await repoStatus($, root) : null
  if (status !== null && status.handoffTracked === null) {
    $.ui.log(REFUSALS.unknownTracked)
    return
  }
  if (status !== null && status.handoffTracked) {
    $.ui.log(REFUSALS.tracked)
    return
  }

  const drift = driftParts(status, isRepo, fields)
  // The archive name by the save time; if it is taken when the first message comes, archive() moves
  // on to -2, -3 and so on.
  const archiveTo = joinPath(joinPath(root, ARCHIVE_DIR), `${archiveStamp(savedTs)}.md`)
  const recorded = await recordSession($, usableSessionId(e.session_id), {
    handoff, sha256: await sha256Hex(bytes), archiveTo, savedTs, drift, at: Date.now(),
  })
  $.ui.log(announcedBanner({ handoff, text, saved, age, drift, archiveTo, recorded }))
}

// The context for this message, or null when it passes on unchanged: it is not from the user, its
// session has no record, it is not the session's first, or it hands the file to /torch:load-handoff.
// On the first message the handoff is archived first, so the context says where it now is.
async function firstMessageContext($, e) {
  if (!USER_ORIGINS.has(e.origin?.kind)) return null
  const sessionId = usableSessionId(await $.session.id())
  if (sessionId === null || answered.has(sessionId)) return null
  answered.add(sessionId)
  // A session on an unsupported platform never announced a handoff, so it has nothing to deliver.
  if (!(await $.session.cwd()).startsWith('/')) return null
  const key = RECORD_PREFIX + sessionId
  const record = await $.store.get(key)
  if (record === undefined) return null
  // Delete the record before acting, so a later session never acts on it again.
  await $.store.delete(key)
  if (LOAD_SKILL.test(typeof e.text === 'string' ? e.text : '')) return null
  if (!isRecord(record)) throw new Error('the session record is not valid')
  // Everything the report needs is worked out before a file moves.
  const facts = {
    handoff: record.handoff, saved: localTime(record.savedTs),
    age: humanAge(Date.now() / 1000 - record.savedTs), drift: record.drift,
  }
  const outcome = await archive($, record.handoff, record.sha256, record.archiveTo)
  const texts = deliveredTexts({ ...outcome, ...facts })
  $.ui.log(texts.banner)
  return texts.context
}

// The stat of a symbolic link that leads nowhere, which $.fs.exists reports as absent, or null
// when nothing is at the path.
async function brokenLink($, file) {
  let stat
  try {
    stat = await $.fs.stat(file)
  } catch (error) {
    return null
  }
  return stat.isLink ? stat : null
}

async function isSkippedSession($) {
  return isOtherHost(await $.env.get('CLAUDE_CODE_ENTRYPOINT'), await $.env.get('CLAUDE_CODE_SESSION_ATTENDED'))
}

// Whether this session now has a record to deliver by. Without a usable id, or when the store
// refuses the write, nothing is delivered and the banner says to load the handoff by hand.
async function recordSession($, sessionId, record) {
  if (sessionId === null) return false
  try {
    await $.store.set(RECORD_PREFIX + sessionId, record)
    return true
  } catch (error) {
    return false
  }
}

async function removeStaleRecords($) {
  const cutoff = Date.now() - RECORD_MAX_AGE_DAYS * 86_400_000
  for (const key of await $.store.keys()) {
    if (!key.startsWith(RECORD_PREFIX)) continue
    const record = await $.store.get(key)
    if (!(record && typeof record.at === 'number' && record.at >= cutoff)) await $.store.delete(key)
  }
}

// The enclosing work tree's top level (a folder holding a .git directory or file), else cwd.
async function projectRoot($, cwd) {
  const chain = ancestors(cwd)
  for (const folder of chain) {
    if (await $.fs.exists(joinPath(folder, '.git'))) return { root: folder, isRepo: true }
  }
  return { root: chain[0], isRepo: false }
}

// Two git status calls side by side, run in the project root and written out in full: the work
// tree without the handoff, a claim archive() left and the archive folder, so archiving never
// counts as a change; and the handoff alone with ignored files shown, which says whether it is
// tracked. Asking about ignored files for the whole tree would walk every ignored folder.
async function repoStatus($, root) {
  const [tree, own] = await Promise.all([
    gitOutput($.process.run(['git', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal',
      '--', '.', ':(exclude)handoff-before-clear.md', ':(exclude).handoff-claim-*.md',
      ':(exclude).claude/handoff-archive'], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })),
    gitOutput($.process.run(['git', 'status', '--porcelain=v2', '--untracked-files=normal',
      '--ignored=traditional', '--', 'handoff-before-clear.md'], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })),
  ])
  return parseStatus(tree, own)
}

// Git's complete standard output, or null when git failed, could not run or was cut short.
async function gitOutput(running) {
  let run
  try {
    run = await running
  } catch (error) {
    return null
  }
  return run.exitCode === 0 && !run.isStdoutTruncated ? run.stdout : null
}

async function readBytes($, file) {
  const { base64 } = await $.fs.read(file, { as: 'bytes' })
  return base64ToBytes(base64)
}

// Move the announced handoff into the archive without losing or replacing any file.
//
// Renaming the live file to a private name beside it claims it: one rename in one folder,
// atomic, and the file keeps its identity, so a save another session is still writing lands in
// it. The claim is then hard-linked into place, back to the live path when it is not the
// handoff this session announced, otherwise into the archive, and only then is its private name
// removed. `link` never replaces a file. When no link can be made, the claim stays where it is:
// "kept" when it is the announced handoff, "kept-other" when it is a later save, "kept-unread"
// when it could not be read to tell. Every outcome names where the file is; "archived" and
// "kept" also give the text that was read, which is the announced handoff's.
export async function archive($, handoff, loadedSha, dest) {
  const made = await $.process.run(['mkdir', '-p', '--', '.claude/handoff-archive'], { cwd: parentPath(handoff) })
  if (made.exitCode !== 0) throw new Error(`mkdir failed: ${made.stderr.trim()}`)
  const claim = joinPath(parentPath(handoff), `${CLAIM_PREFIX}${randomHex(16)}.md`)
  const failure = await claimFailure($, handoff, claim)
  if (failure === 'gone') return { outcome: 'gone', place: null }

  let bytes
  try {
    bytes = await readBytes($, claim)
  } catch (error) {
    return { outcome: 'kept-unread', place: claim }
  }
  const matched = (await sha256Hex(bytes)) === loadedSha
  const text = matched ? new TextDecoder().decode(bytes) : undefined
  let outcome
  let place = null
  if (matched) {
    place = await linkFree($, claim, dest)
    outcome = place === null ? 'kept' : 'archived'
  } else {
    const back = await tryLink($, claim, handoff)
    if (back === 'taken') place = await linkFree($, claim, dest)
    outcome = back === 'linked' || place !== null ? 'changed' : 'kept-other'
  }
  if (outcome === 'kept') return { outcome, place: claim, text }
  if (outcome === 'kept-other') return { outcome, place: claim }
  const leftover = await removeClaim($, claim)
  const result = matched ? { outcome, place, text } : { outcome, place }
  return leftover === null ? result : { ...result, leftover }
}

// Null once the handoff is claimed, 'gone' when it and the claim are both absent; throws when the
// claim failed and the handoff is untouched, or when it cannot be told which happened. A failed
// mv does not prove the rename didn't happen, so what is on disk decides.
async function claimFailure($, handoff, claim) {
  let reason
  try {
    const moved = await $.process.run(['mv', '--', handoff, claim])
    if (moved.exitCode === 0) return null
    reason = moved.stderr.trim()
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  // A claim that exists decides by itself; the live path matters only when it doesn't.
  let live
  try {
    if (await $.fs.exists(claim)) return null
    live = await $.fs.exists(handoff)
  } catch (error) {
    throw new Error(`could not tell whether ${handoff} was moved to ${claim}: ${reason}`)
  }
  if (!live) return 'gone'
  throw new Error(`mv could not claim ${handoff}: ${reason}`)
}

// Hard-link source at dest, or at dest-2, dest-3, ... while a name is taken; null when no link
// can be made at all.
async function linkFree($, source, dest) {
  const stem = dest.slice(0, -'.md'.length)
  for (let n = 1; ; n += 1) {
    const target = n === 1 ? dest : `${stem}-${n}.md`
    const linked = await tryLink($, source, target)
    if (linked === 'linked') return target
    if (linked === 'failed') return null
  }
}

// 'linked', 'taken' when something is already at target, or 'failed', which includes not being
// able to tell: the caller then keeps the source where it is.
async function tryLink($, source, target) {
  let linked
  try {
    linked = (await $.process.run(['link', source, target])).exitCode === 0
  } catch (error) {
    linked = false   // a call that failed may still have linked: what is at target decides
  }
  if (linked) return 'linked'
  try {
    return (await $.fs.exists(target)) ? 'taken' : 'failed'
  } catch (error) {
    return 'failed'
  }
}

// Null once the claim's name is gone, else the claim, which may remain and is reported.
async function removeClaim($, claim) {
  let removed
  try {
    removed = (await $.process.run(['rm', '-f', '--', claim])).exitCode === 0
  } catch (error) {
    removed = false   // a call that failed may still have removed it: whether it is there decides
  }
  if (removed) return null
  try {
    return (await $.fs.exists(claim)) ? claim : null
  } catch (error) {
    return claim
  }
}
