// The review log: one JSON event per line in <git-dir>/review-notes.jsonl.
// The extension (human) and the CLI (agent) only ever append, so state is
// rebuilt by folding the whole log. Lives in the git dir so the working tree
// stays clean and `git worktree remove` takes the review with it.

const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const LOG = 'review-notes.jsonl'

function repoOf(dir, exec = execFileSync) {
  const [top, gitDir] = exec(
    'git',
    ['-C', dir, 'rev-parse', '--show-toplevel', '--absolute-git-dir'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  )
    .trim()
    .split('\n')
  return { top, log: path.join(gitDir, LOG) }
}

function append(file, events) {
  const now = new Date().toISOString()
  const full = events.map((e) => ({ id: crypto.randomUUID(), at: now, ...e }))
  let text = full.map((e) => JSON.stringify(e) + '\n').join('')
  // A writer that died mid-line would otherwise glue this line onto its fragment.
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const fd = fs.openSync(file, 'r')
    const last = Buffer.alloc(1)
    fs.readSync(fd, last, 0, 1, fs.fstatSync(fd).size - 1)
    fs.closeSync(fd)
    if (last[0] !== 0x0a) text = '\n' + text
  }
  fs.appendFileSync(file, text)
  return full
}

function read(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  // Whatever follows the last newline is still being written.
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n')
  const events = []
  for (const line of lines) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {}
  }
  return events
}

function fold(events) {
  const threads = new Map()
  for (const e of events) {
    if (e.type === 'add') {
      const { type, ...rest } = e
      threads.set(e.id, { ...rest, replies: [], resolved: false, read: false })
      continue
    }
    const t = threads.get(e.thread)
    if (!t) continue
    if (e.type === 'reply')
      t.replies.push({ id: e.id, by: e.by, at: e.at, body: e.body })
    else if (e.type === 'resolve') t.resolved = true
    else if (e.type === 'reopen') t.resolved = false
    else if (e.type === 'read') t.read = true
    else if (e.type === 'unread') t.read = false
  }
  return threads
}

const lastBy = (t) => (t.replies.at(-1) ?? t).by

const unanswered = (threads) =>
  [...threads.values()].filter((t) => !t.resolved && lastBy(t) === 'human')

const initialExpand = (t) => !t.resolved && lastBy(t) === 'agent'

function fresh(events, mark) {
  const known =
    mark &&
    mark.count <= events.length &&
    events[mark.count - 1]?.id === mark.lastId
  return {
    news: known ? events.slice(mark.count) : events,
    mark: { count: events.length, lastId: events.at(-1)?.id },
  }
}

// The base is the repository top as seen through the folder VS Code opened, so
// a symlinked or sub-folder workspace still yields URIs its editors use.
const baseOf = (folderFsPath, top) =>
  path.join(folderFsPath, path.relative(fs.realpathSync(folderFsPath), top))

const relPath = (base, fsPath) =>
  path.relative(base, fsPath).split(path.sep).join('/')

const absPath = (base, rel) => path.join(base, ...rel.split('/'))

module.exports = {
  repoOf,
  append,
  read,
  fold,
  lastBy,
  unanswered,
  initialExpand,
  fresh,
  baseOf,
  relPath,
  absPath,
}
