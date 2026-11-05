#!/usr/bin/env node
// review-notes --workspace <dir> post <entries.json>
//   entries: [{path, line, body, card?, side?} | {reply_to, body}]; written as
//   agent in one append. side 'old' targets the HEAD side of the diff.
//   stdout: [{id} | {error}] in input order
// review-notes --workspace <dir> focus --thread <id>
// review-notes --workspace <dir> list [--unanswered]
// review-notes --workspace <dir> archive --label <label>
//
// exit: 0 = ok, 1 = some entries or the target failed, 2 = usage

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import * as store from '../store'

const USAGE =
  'usage: review-notes --workspace <dir> post <entries.json> | focus --thread <id> | list [--unanswered] | archive --label <label>'

type Result = { id: string } | { error: string }

// The old side of the working-tree diff is HEAD, so a file deleted in the
// working tree is still a valid target there.
function atHead(top: string, rel: string): boolean {
  try {
    execFileSync('git', ['-C', top, 'cat-file', '-e', `HEAD:${rel}`], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function fail(code: number, message: string): never {
  console.error(`review-notes: ${message}`)
  process.exit(code)
}

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Entries come from a file the agent wrote, so every field is checked here
// rather than trusted from the type.
function toEvent(
  e: Record<string, unknown>,
  top: string,
  threads: Map<string, store.Thread>,
): store.NewEvent | { error: string } {
  const body = typeof e.body === 'string' ? e.body : ''
  if (e.reply_to) {
    const thread = String(e.reply_to)
    if (!threads.has(thread)) return { error: `no thread ${thread}` }
    return { type: 'reply', by: 'agent', thread, body }
  }
  const { path: rel, line, side, card } = e
  if (typeof rel !== 'string' || !rel || !Number.isInteger(line) || (line as number) < 1)
    return { error: 'entry needs path and a 1-based line' }
  if (side !== undefined && side !== 'old' && side !== 'new')
    return { error: `side must be "old" or "new", not ${JSON.stringify(side)}` }
  if (side === 'old' ? !atHead(top, rel) : !fs.existsSync(store.absPath(top, rel)))
    return { error: `no file ${rel}${side === 'old' ? ' at HEAD' : ''}` }
  const add: store.NewEvent = { type: 'add', by: 'agent', path: rel, line: line as number, body }
  if (side === 'old') add.side = 'old'
  if (card !== undefined) add.card = card as number
  return add
}

function main(): void {
  let args
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        workspace: { type: 'string' },
        thread: { type: 'string' },
        label: { type: 'string' },
        unanswered: { type: 'boolean' },
      },
    })
  } catch (e) {
    fail(2, `${errorOf(e)}\n${USAGE}`)
  }
  const { values, positionals } = args
  const [command, file] = positionals
  if (!values.workspace || !command) fail(2, USAGE)

  let repo: { top: string; log: string }
  try {
    repo = store.repoOf(values.workspace)
  } catch {
    fail(2, `${values.workspace} is not inside a git repository`)
  }
  const print = (v: unknown): void => {
    process.stdout.write(JSON.stringify(v, null, 2) + '\n')
  }

  if (command === 'post') {
    let entries: unknown
    try {
      entries = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(entries))
        throw new Error('entries must be a JSON array')
    } catch (e) {
      fail(2, errorOf(e))
    }
    const threads = store.fold(store.read(repo.log))
    const checked = entries.map((e: unknown) =>
      typeof e === 'object' && e !== null
        ? toEvent(e as Record<string, unknown>, repo.top, threads)
        : { error: 'entry must be an object' },
    )
    const events = checked.filter((c): c is store.NewEvent => !('error' in c))
    const written = events.length ? store.append(repo.log, events) : []
    let next = 0
    const out: Result[] = checked.map((c) =>
      'error' in c ? c : { id: written[next++].id },
    )
    print(out)
    process.exit(out.some((r) => 'error' in r) ? 1 : 0)
  }

  if (command === 'focus') {
    const thread = values.thread
    if (!thread) fail(2, USAGE)
    if (!store.fold(store.read(repo.log)).has(thread))
      fail(1, `no thread ${thread}`)
    const [e] = store.append(repo.log, [
      { type: 'focus', by: 'agent', thread },
    ])
    return print({ id: e.id })
  }

  if (command === 'list') {
    const threads = store.fold(store.read(repo.log))
    return print(
      values.unanswered ? store.unanswered(threads) : [...threads.values()],
    )
  }

  if (command === 'archive') {
    if (!values.label) fail(2, USAGE)
    if (!fs.existsSync(repo.log)) return print({ archived: null })
    const to = path.join(
      path.dirname(repo.log),
      `review-notes.${values.label}.jsonl`,
    )
    if (fs.existsSync(to)) fail(1, `${to} already exists`)
    fs.renameSync(repo.log, to)
    return print({ archived: to })
  }

  fail(2, USAGE)
}

main()
