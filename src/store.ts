// The review log: one JSON event per line in <git-dir>/review-notes.jsonl.
// The extension (human) and the CLI (agent) only ever append, so state is
// rebuilt by folding the whole log. Lives in the git dir so the working tree
// stays clean and `git worktree remove` takes the review with it.

import { execFileSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

const LOG = 'review-notes.jsonl'

export type By = 'human' | 'agent'
export type Side = 'old' | 'new'

export interface AddFields {
  path: string
  line: number
  body: string
  card?: number
  side?: 'old'
}

export type NewEvent = { by: By } & (
  | ({ type: 'add' } & AddFields)
  | { type: 'reply'; thread: string; body: string }
  | {
      type: 'resolve' | 'reopen' | 'read' | 'unread' | 'focus'
      thread: string
    }
)

export type LogEvent = NewEvent & { id: string; at: string }

export interface Reply {
  id: string
  by: By
  at: string
  body: string
}

export interface Thread extends AddFields {
  id: string
  at: string
  by: By
  replies: Reply[]
  resolved: boolean
  read: boolean
}

export interface Mark {
  count: number
  lastId: string | undefined
}

type Exec = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; stdio: ['ignore', 'pipe', 'ignore'] },
) => string

export function repoOf(
  dir: string,
  exec: Exec = execFileSync,
): { top: string; log: string } {
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

export function append(file: string, events: NewEvent[]): LogEvent[] {
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

// Lines are only parsed, not validated: a hand-edited log can hold anything,
// so readers of the folded threads still check the fields they rely on.
export function read(file: string): LogEvent[] {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  // Whatever follows the last newline is still being written.
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n')
  const events: LogEvent[] = []
  for (const line of lines) {
    if (!line) continue
    try {
      events.push(JSON.parse(line) as LogEvent)
    } catch {}
  }
  return events
}

export function fold(events: LogEvent[]): Map<string, Thread> {
  const threads = new Map<string, Thread>()
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

export const lastBy = (t: Thread): By => (t.replies.at(-1) ?? t).by

export const unanswered = (threads: Map<string, Thread>): Thread[] =>
  [...threads.values()].filter((t) => !t.resolved && lastBy(t) === 'human')

export const initialExpand = (t: Thread): boolean =>
  !t.resolved && lastBy(t) === 'agent'

export function fresh<E extends { id: string }>(
  events: E[],
  mark: Mark | undefined,
): { news: E[]; mark: Mark } {
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
export const baseOf = (folderFsPath: string, top: string): string =>
  path.join(folderFsPath, path.relative(fs.realpathSync(folderFsPath), top))

export const relPath = (base: string, fsPath: string): string =>
  path.relative(base, fsPath).split(path.sep).join('/')

export const absPath = (base: string, rel: string): string =>
  path.join(base, ...rel.split('/'))
