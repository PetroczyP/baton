// Torch, a Claude Code mod: loads the project's handoff-before-clear.md into each new
// interactive session, and moves it into .claude/handoff-archive/ on the session's first
// message so the next session starts fresh.
//
//   classic.SessionStart (startup, clear)  adds the handoff to Claude's context and logs a
//                                          one-line banner with the git drift since the save
//   classic.UserPromptSubmit               archives the loaded handoff on the first prompt,
//                                          unless that prompt is /torch:load-handoff
//
// Every function that is handed `$` is declared in this file, as `claude plugin validate`
// requires; rules.mjs holds the rules that need no file or process access. Torch never blocks
// an event: a failure is logged and the event goes on.
import {
  ARCHIVE_DIR, HANDOFF_NAME, MAX_AGE_DAYS, READ_LIMIT, RECORD_MAX_AGE_DAYS, REFUSALS,
  ancestors, archiveStamp, archivedTexts, base64ToBytes, contractFields, driftParts, hasTitle,
  humanAge, isOtherHost, isRecord, joinPath, loadedTexts, localTime, parentPath, parseStatus,
  randomHex, sha256Hex, usableSessionId,
} from './rules.mjs'

const GIT_TIMEOUT_MS = 5_000
const CLAIM_PREFIX = '.handoff-claim-'
const RECORD_PREFIX = 'session:'
const LOAD_SKILL = /^\s*\/(?:torch:)?load-handoff(\s|$)/

export function register(on) {
  on('classic.SessionStart', { source: ['startup', 'clear'] }, loadHandoff)
    .catch(($, e, next) => reportFailure($, 'load', e, next))
  on('classic.UserPromptSubmit', archiveOnFirstPrompt)
    .catch(($, e, next) => reportFailure($, 'archive', e, next))
}

// A failed hook is logged, and the event continues: with the result `next` already gave, or
// by calling it now.
export async function reportFailure($, verb, e, next) {
  $.ui.log(`could not ${verb} the handoff: ${next.error?.message ?? 'unknown error'}`)
  return next.called ? undefined : next(e)
}

export async function loadHandoff($, e, next) {
  const result = await next(e)
  const context = await handoffContext($, e)
  if (context === null) return result
  return { ...result, additionalContext: [...(result?.additionalContext ?? []), context] }
}

export async function archiveOnFirstPrompt($, e, next) {
  const result = await next(e)
  const sessionId = usableSessionId(e.session_id)
  if (sessionId === null) return result
  const key = RECORD_PREFIX + sessionId
  const record = await $.store.get(key)
  // A prompt another hook blocked never reached Claude: the record waits for the next one.
  if (record === undefined || result?.block) return result
  // Delete the record before acting: whatever happens next, this session tries at most once.
  await $.store.delete(key)
  if (LOAD_SKILL.test(typeof e.prompt === 'string' ? e.prompt : '')) return result
  if (!isRecord(record)) throw new Error('the session record is not valid')
  const outcome = await archive($, record.handoff, record.sha256, record.archiveTo)
  const texts = archivedTexts({ ...outcome, handoff: record.handoff })
  if (texts === null) return result
  $.ui.log(texts.banner)
  return { ...result, additionalContext: [...(result?.additionalContext ?? []), texts.context] }
}

// The context to add for this session's handoff, or null. Refusals are logged as banners.
async function handoffContext($, e) {
  if (await isSkippedSession($)) return null
  const cwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : await $.session.cwd()
  if (!cwd.startsWith('/')) {
    $.ui.log(REFUSALS.platform)
    return null
  }
  await removeStaleRecords($)
  const { root, isRepo } = await projectRoot($, cwd)
  const handoff = joinPath(root, HANDOFF_NAME)
  const stat = (await $.fs.exists(handoff)) ? await $.fs.stat(handoff) : await brokenLink($, handoff)
  if (stat === null) return null
  if (stat.isLink) {
    $.ui.log(REFUSALS.symlink)
    return null
  }
  if (stat.kind !== 'file') return null
  if (stat.size > READ_LIMIT) {
    $.ui.log(REFUSALS.tooLarge)
    return null
  }

  const bytes = await readBytes($, handoff)
  const text = new TextDecoder().decode(bytes)
  if (!hasTitle(text)) {
    $.ui.log(REFUSALS.untitled)
    return null
  }
  const fields = contractFields(text)
  const savedTs = fields ? fields.savedTs : stat.mtimeMs / 1000
  const ageSeconds = Date.now() / 1000 - savedTs
  const saved = localTime(savedTs)
  const age = humanAge(ageSeconds)
  if (ageSeconds > MAX_AGE_DAYS * 86_400) {
    $.ui.log(REFUSALS.old(saved, age))
    return null
  }

  const status = isRepo ? await repoStatus($, root) : null
  if (status !== null && status.handoffTracked === null) {
    $.ui.log(REFUSALS.unknownTracked)
    return null
  }
  if (status !== null && status.handoffTracked) {
    $.ui.log(REFUSALS.tracked)
    return null
  }

  const drift = driftParts(status, isRepo, fields)
  const archiveTo = await freeArchivePath($, root, savedTs)
  const recorded = await recordSession($, usableSessionId(e.session_id), {
    handoff, sha256: await sha256Hex(bytes), archiveTo, at: Date.now(),
  })
  const { context, banner } = loadedTexts({ handoff, text, saved, age, drift, archiveTo, recorded })
  $.ui.log(banner)
  return context
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

// Whether this session now has a record to archive by. Without a usable id, or when the store
// refuses the write, the handoff still loads and is left in place.
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

// Two git status calls side by side: the work tree without the handoff, a claim archive() left
// and the archive folder, so archiving never counts as a change, and the handoff alone with ignored files shown, which
// says whether it is tracked. Asking about ignored files for the whole tree would walk every
// ignored folder.
async function repoStatus($, root) {
  const [tree, own] = await Promise.all([
    gitOutput($, root, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--', '.',
      `:(exclude)${HANDOFF_NAME}`, `:(exclude)${CLAIM_PREFIX}*.md`, `:(exclude)${ARCHIVE_DIR}`]),
    gitOutput($, root, ['status', '--porcelain=v2', '--untracked-files=normal', '--ignored=traditional',
      '--', HANDOFF_NAME]),
  ])
  return parseStatus(tree, own)
}

// Git's complete standard output, or null when git failed, could not run or was cut short.
async function gitOutput($, root, args) {
  let run
  try {
    run = await $.process.run(['git', '-C', root, ...args], { timeoutMs: GIT_TIMEOUT_MS })
  } catch (error) {
    return null
  }
  return run.exitCode === 0 && !run.isStdoutTruncated ? run.stdout : null
}

async function freeArchivePath($, root, savedTs) {
  const folder = joinPath(root, ARCHIVE_DIR)
  const stamp = archiveStamp(savedTs)
  let candidate = joinPath(folder, `${stamp}.md`)
  for (let n = 2; await $.fs.exists(candidate); n += 1) candidate = joinPath(folder, `${stamp}-${n}.md`)
  return candidate
}

async function readBytes($, file) {
  const { base64 } = await $.fs.read(file, { as: 'bytes' })
  return base64ToBytes(base64)
}

// Move the loaded handoff into the archive without losing or replacing any file.
//
// Renaming the live file to a private name beside it claims it: one rename in one folder,
// atomic, and the file keeps its identity, so a save another session is still writing lands in
// it. The claim is then hard-linked into place, back to the live path when it is not the
// handoff this session loaded, otherwise into the archive, and only then is its private name
// removed. `link` never replaces a file. When no link can be made, the claim stays where it is:
// "kept" when it is the loaded handoff, "kept-other" when it is a later save, "kept-unread"
// when it could not be read to tell. Every outcome names where the file is.
export async function archive($, handoff, loadedSha, dest) {
  await mustRun($, ['mkdir', '-p', '--', parentPath(dest)])
  const claim = joinPath(parentPath(handoff), `${CLAIM_PREFIX}${randomHex(16)}.md`)
  const failure = await claimFailure($, handoff, claim)
  if (failure === 'gone') return { outcome: 'gone', place: null }

  let matched
  try {
    matched = (await sha256Hex(await readBytes($, claim))) === loadedSha
  } catch (error) {
    return { outcome: 'kept-unread', place: claim }
  }
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
  if (outcome === 'kept' || outcome === 'kept-other') return { outcome, place: claim }
  const leftover = await removeClaim($, claim)
  return leftover === null ? { outcome, place } : { outcome, place, leftover }
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
  let claimed
  let live
  try {
    claimed = await $.fs.exists(claim)
    live = await $.fs.exists(handoff)
  } catch (error) {
    throw new Error(`could not tell whether ${handoff} was moved to ${claim}: ${reason}`)
  }
  if (claimed) return null
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

// 'linked', 'taken' when something is already at target, or 'failed'.
async function tryLink($, source, target) {
  let run
  try {
    run = await $.process.run(['link', source, target])
  } catch (error) {
    return 'failed'
  }
  if (run.exitCode === 0) return 'linked'
  return (await $.fs.exists(target)) ? 'taken' : 'failed'
}

// Null once the claim's name is gone, else the claim, which the report then names.
async function removeClaim($, claim) {
  let run
  try {
    run = await $.process.run(['rm', '-f', '--', claim])
  } catch (error) {
    return claim
  }
  return run.exitCode === 0 ? null : claim
}

async function mustRun($, argv) {
  const run = await $.process.run(argv)
  if (run.exitCode !== 0) throw new Error(`${argv[0]} failed: ${run.stderr.trim()}`)
}
