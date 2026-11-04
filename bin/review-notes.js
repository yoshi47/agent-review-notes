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

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { parseArgs } = require('node:util')

const store = require('../store')

const USAGE =
  'usage: review-notes --workspace <dir> post <entries.json> | focus --thread <id> | list [--unanswered] | archive --label <label>'

// The old side of the working-tree diff is HEAD, so a file deleted in the
// working tree is still a valid target there.
function atHead(top, rel) {
  try {
    execFileSync('git', ['-C', top, 'cat-file', '-e', `HEAD:${rel}`], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function fail(code, message) {
  console.error(`review-notes: ${message}`)
  process.exit(code)
}

function main() {
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
    fail(2, `${e.message}\n${USAGE}`)
  }
  const { values, positionals } = args
  const [command, file] = positionals
  if (!values.workspace || !command) fail(2, USAGE)

  let repo
  try {
    repo = store.repoOf(values.workspace)
  } catch {
    fail(2, `${values.workspace} is not inside a git repository`)
  }
  const print = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n')

  if (command === 'post') {
    let entries
    try {
      entries = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(entries))
        throw new Error('entries must be a JSON array')
    } catch (e) {
      fail(2, e.message)
    }
    const threads = store.fold(store.read(repo.log))
    const results = []
    const events = []
    for (const e of entries) {
      if (e.reply_to) {
        if (!threads.has(e.reply_to))
          results.push({ error: `no thread ${e.reply_to}` })
        else
          results.push(
            events.push({
              type: 'reply',
              by: 'agent',
              thread: e.reply_to,
              body: e.body,
            }) - 1,
          )
      } else if (typeof e.path !== 'string' || !e.path || !Number.isInteger(e.line) || e.line < 1) {
        results.push({ error: 'entry needs path and a 1-based line' })
      } else if (e.side !== undefined && e.side !== 'old' && e.side !== 'new') {
        results.push({ error: `side must be "old" or "new", not ${JSON.stringify(e.side)}` })
      } else if (e.side === 'old' ? !atHead(repo.top, e.path) : !fs.existsSync(store.absPath(repo.top, e.path))) {
        results.push({ error: `no file ${e.path}${e.side === 'old' ? ' at HEAD' : ''}` })
      } else {
        const add = {
          type: 'add',
          by: 'agent',
          path: e.path,
          line: e.line,
          body: e.body,
        }
        if (e.side === 'old') add.side = 'old'
        if (e.card !== undefined) add.card = e.card
        results.push(events.push(add) - 1)
      }
    }
    const written = events.length ? store.append(repo.log, events) : []
    const out = results.map((r) =>
      typeof r === 'number' ? { id: written[r].id } : r,
    )
    print(out)
    process.exit(out.some((r) => r.error) ? 1 : 0)
  }

  if (command === 'focus') {
    if (!values.thread) fail(2, USAGE)
    if (!store.fold(store.read(repo.log)).has(values.thread))
      fail(1, `no thread ${values.thread}`)
    const [e] = store.append(repo.log, [
      { type: 'focus', by: 'agent', thread: values.thread },
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
