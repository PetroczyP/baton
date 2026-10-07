// Torch's rules that need no access to files or processes: reading the handoff contract,
// describing git drift, and the texts Torch shows the user and gives Claude. torch.mjs does
// the reading, running and writing.

export const HANDOFF_NAME = 'handoff-before-clear.md'
export const ARCHIVE_DIR = '.claude/handoff-archive'
export const MAX_AGE_DAYS = 14             // older handoffs are announced, not loaded
export const CONTEXT_LIMIT = 9_800         // Torch inlines a handoff up to this many UTF-16 units
export const RECORD_MAX_AGE_DAYS = 30      // records of sessions that never sent a prompt
export const READ_LIMIT = 4 * 1024 * 1024  // $.fs.read refuses larger files

// Entry points of hosts other than interactive Claude Code on the user's machine, as Claude Code
// names them: Cowork, cloud sessions, the SDK, MCP mode, the GitHub Action, Slack and Teams.
const OTHER_HOSTS = new Set(['local-agent', 'local_agent', 'mcp', 'claude-code-github-action',
  'claude-in-teams', 'claude_in_slack', 'claude-in-slack'])

export function isOtherHost(entrypoint, attended) {
  if (attended === '0') return true
  const name = entrypoint ?? ''
  return OTHER_HOSTS.has(name) || name.includes('cowork') || name.startsWith('sdk-') || name.startsWith('remote')
}

export function usableSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? sessionId : null
}

export function hasTitle(text) {
  return /^# Handoff(\s.*)?$/m.test(text)
}

// Python's str.splitlines boundaries, which v1 split the front matter on.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/
const CONTRACT_KEYS = ['branch', 'handoff', 'head', 'saved_at']

// The contract's front matter, or null when it is missing or not exactly valid. Values are
// single-line command output taken literally; a quoted value, a missing or repeated key, or a
// value of the wrong shape makes the whole block count as absent.
export function contractFields(text) {
  const lines = text.split(LINE_BREAK)
  const end = lines.indexOf('---', 1)
  if (lines[0] !== '---' || end === -1) return null
  const fields = Object.create(null)
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(':')
    if (at === -1) return null
    const key = line.slice(0, at)
    if (Object.hasOwn(fields, key)) return null
    fields[key] = line.slice(at + 1).trim()
  }
  if (Object.keys(fields).sort().join() !== CONTRACT_KEYS.join() || fields.handoff !== '1') return null
  const savedTs = utcSeconds(fields.saved_at)
  if (savedTs === null) return null
  if (!(fields.head === 'none' || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields.head))) return null
  if (!/^[^\s"'`]+$/.test(fields.branch)) return null
  return { ...fields, savedTs }
}

// Seconds since the epoch for a real UTC time written as `date -u +%Y-%m-%dT%H:%M:%SZ` prints it.
function utcSeconds(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value)
  if (!m) return null
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number)
  if (year === 0) return null
  // setUTCFullYear, unlike Date.UTC, keeps years 1 to 99 as written.
  const back = new Date(0)
  back.setUTCFullYear(year, month - 1, day)
  back.setUTCHours(hour, minute, second, 0)
  const ms = back.getTime()
  const exact = back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day
    && back.getUTCHours() === hour && back.getUTCMinutes() === minute && back.getUTCSeconds() === second
  return exact ? ms / 1000 : null
}

// Branch, HEAD, uncommitted changes and whether the handoff is tracked, from the two git
// status calls (porcelain v2). `tree` is the work tree without the handoff and the archive;
// `own` is the handoff alone with ignored files shown. Either is null when its call failed.
export function parseStatus(tree, own) {
  const facts = { tree: tree !== null, branch: null, head: null, changes: 0, handoffTracked: null }
  if (own !== null) facts.handoffTracked = !own.split('\n').some((line) => ['? ', '! '].includes(line.slice(0, 2)))
  for (const line of (tree ?? '').split('\n')) {
    if (line.startsWith('# branch.head ')) facts.branch = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length)
      facts.head = oid === '(initial)' ? null : oid
    } else if (['1 ', '2 ', 'u ', '? '].includes(line.slice(0, 2))) facts.changes += 1
  }
  return facts
}

export function driftParts(status, isRepo, fields) {
  if (!isRepo) return ['not a git repo']
  if (status === null || !status.tree) return ['git state unavailable']
  const { branch, head, changes } = status
  const savedBranch = fields && fields.branch !== 'none' ? fields.branch : null
  const savedHead = fields && fields.head !== 'none' ? fields.head : null
  const parts = [savedBranch === null ? `branch ${branch}`
    : savedBranch === branch ? `branch ${branch} ✓`
      : `⚠ branch ${branch}, handoff was on ${savedBranch}`]
  if (savedHead && head) {
    parts.push(head === savedHead ? 'no new commits'
      : `⚠ HEAD moved since the handoff (${savedHead.slice(0, 7)} → ${head.slice(0, 7)})`)
  } else if (fields === null) {
    parts.push('no saved git state to compare')
  }
  parts.push(changes === 0 ? 'clean' : `${changes} uncommitted change${changes === 1 ? '' : 's'}`)
  return parts
}

export function humanAge(seconds) {
  const minutes = Math.max(0, Math.floor(seconds / 60))
  if (minutes < 90) return `${minutes} min`
  if (minutes < 36 * 60) return `${Math.floor(minutes / 60)} h`
  return `${Math.floor(minutes / (24 * 60))} d`
}

// The local date and time, as `2026-10-06 14:54 GMT+2`.
export function localTime(seconds) {
  const when = new Date(seconds * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(when)
    .find((part) => part.type === 'timeZoneName')?.value
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} `
    + `${pad(when.getHours())}:${pad(when.getMinutes())}${zone ? ` ${zone}` : ''}`
}

// The archive name's stamp, the save time in UTC: 20261006T145432Z.
export function archiveStamp(seconds) {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll('-', '').replaceAll(':', '')
}

export function joinPath(folder, name) {
  return folder.endsWith('/') ? `${folder}${name}` : `${folder}/${name}`
}

export function parentPath(file) {
  const at = file.lastIndexOf('/')
  return at <= 0 ? '/' : file.slice(0, at)
}

// The folder and each of its parents up to the file system root, nearest first.
export function ancestors(folder) {
  const parts = folder.split('/').filter(Boolean)
  const chain = []
  for (let n = parts.length; n > 0; n -= 1) chain.push(`/${parts.slice(0, n).join('/')}`)
  chain.push('/')
  return chain
}

export const GUIDANCE = [
  '- If this message continues the work in the handoff, pick up from it without asking the user to '
    + 'confirm, and first mention any drift above in one line.',
  '- If this message is about something else, leave the handoff aside.',
  "- The user's messages take precedence over the handoff.",
]

// What Claude reads with the first message when the handoff is delivered: the header, then the
// handoff itself, or where to read it when the whole would pass CONTEXT_LIMIT UTF-16 units.
function handoffContext({ handoff, place, location, saved, age, drift, text }) {
  const header = "This project's handoff file was loaded automatically with this message (torch plugin). "
    + 'Torch does not check who wrote it.\n\n'
    + `File: ${handoff}, saved ${saved}, ${age} ago. ${location}\n`
    + `Git at session start, compared with the handoff: ${drift.join('; ')}.\n\n`
    + `How to use it:\n${GUIDANCE.join('\n')}\n`
  const inline = `${header}\n<handoff>\n${text.trimEnd()}\n</handoff>`
  if (inline.length <= CONTEXT_LIMIT) return { context: inline, inline: true }
  const size = [...text].length.toLocaleString('en-US')
  return {
    context: `${header}\nThe handoff is ${size} characters, too long to include here. Read it at ${place} `
      + 'before acting on it.',
    inline: false,
  }
}

// The banner at session start. Whether the handoff will be pointed to rather than included is
// judged with the archive name planned now.
export function announcedBanner({ handoff, text, saved, age, drift, archiveTo, recorded }) {
  const facts = `saved ${saved} (${age} ago) · ${drift.join(' · ')}`
  if (!recorded) {
    return `Handoff found: ${facts}. Torch could not record this session, so run /torch:load-handoff to use it.`
  }
  const { inline } = handoffContext({
    handoff, place: archiveTo, location: `It is now archived at ${archiveTo}.`, saved, age, drift, text,
  })
  const size = inline ? '' : ` · ${[...text].length.toLocaleString('en-US')} chars, Claude reads it from the file`
  return `Handoff ready: ${facts}${size}. Claude gets it with your first message, which archives it.`
}

// What the user and Claude are told with the first message, by the archive's outcome. The handoff
// is delivered only when it was read and is the one announced: "archived" and "kept".
export function deliveredTexts({ outcome, place, handoff, leftover, text, saved, age, drift }) {
  const extra = leftover ? ` Torch could not remove its temporary name for it, ${leftover}, which may remain.` : ''
  const none = 'No handoff was delivered with this message.'
  switch (outcome) {
    case 'archived':
      return {
        banner: `Handoff archived to ${place}${leftover ? `.${extra}` : ''}`,
        context: handoffContext({ handoff, place, location: `It is now archived at ${place}.${extra}`, saved, age, drift, text }).context,
      }
    case 'kept':
      return {
        banner: `Could not archive ${HANDOFF_NAME}: it could not be linked into the archive. It is kept at ${place}.`,
        context: handoffContext({ handoff, place, location: `It could not be archived and is now at ${place}.`, saved, age, drift, text }).context,
      }
    case 'changed':
      return {
        banner: `${HANDOFF_NAME} changed after it was announced, so Claude didn't get it; the file was left for the `
          + `next session${place ? ` (an earlier save is kept in ${place})` : ''}.${extra}`,
        context: `${none} Another session saved a newer handoff after this session announced its own. The file at `
          + `${handoff} is that newer handoff, not the one announced at session start`
          + (place ? `; an intermediate save is kept at ${place}.` : '.') + extra,
      }
    case 'kept-other':
      return {
        banner: `${HANDOFF_NAME} changed after it was announced and could not be put back, so Claude didn't get it. `
          + `The newer file is at ${place}.`,
        context: `${none} A handoff saved after this session announced its own is now at ${place}. It is not the `
          + 'handoff announced at session start.',
      }
    case 'kept-unread':
      return {
        banner: `Could not archive ${HANDOFF_NAME}: the file could not be read, so Claude didn't get it. It is kept at ${place}.`,
        context: `${none} The handoff file is now at ${place}. It could not be read, so it is unknown whether `
          + 'it is the one announced at session start.',
      }
    case 'gone':
      return { banner: `${HANDOFF_NAME} was gone before your first message, so Claude didn't get it.`, context: null }
    default:
      throw new Error(`unknown archive outcome: ${outcome}`)
  }
}

export const REFUSALS = {
  symlink: `${HANDOFF_NAME} is a symbolic link, so it was not loaded or moved. Run /torch:load-handoff to use it.`,
  untitled: `${HANDOFF_NAME} has no '# Handoff' title, so it was not loaded. Run /torch:load-handoff to look at it.`,
  tooLarge: `${HANDOFF_NAME} is over 4 MiB, so it was not loaded. Run /torch:load-handoff to look at it.`,
  unknownTracked: `Could not check with git whether ${HANDOFF_NAME} is committed to this repo, so it was not `
    + 'loaded. Run /torch:load-handoff if it is yours.',
  tracked: `${HANDOFF_NAME} is committed to this repo, so it was not loaded. Run /torch:load-handoff if it is yours.`,
  platform: 'Torch supports macOS and Linux; the handoff was not loaded.',
  old: (saved, age) => `A handoff from ${saved} (${age} old) is here but was not loaded: it is older than `
    + `${MAX_AGE_DAYS} days. Run /torch:load-handoff to use it.`,
}

export function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function randomHex(byteCount) {
  return [...crypto.getRandomValues(new Uint8Array(byteCount))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// JavaScript dates reach 8.64e15 ms either side of 1970.
const MAX_DATE_SECONDS = 8.64e12

// A session record as announce() writes it.
export function isRecord(value) {
  return value !== null && typeof value === 'object'
    && ['handoff', 'sha256', 'archiveTo'].every((key) => typeof value[key] === 'string')
    && Number.isFinite(value.savedTs) && Math.abs(value.savedTs) <= MAX_DATE_SECONDS
    && Array.isArray(value.drift) && value.drift.every((part) => typeof part === 'string')
}
