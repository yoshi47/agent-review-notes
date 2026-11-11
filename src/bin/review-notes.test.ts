import * as assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import * as store from '../store'

const CLI = path.join(__dirname, 'review-notes.js')

function repo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rn-cli-')))
  execFileSync('git', ['init', '-q', d])
  fs.writeFileSync(path.join(d, 'a b.ts'), '')
  fs.mkdirSync(path.join(d, '@x'))
  fs.writeFileSync(path.join(d, '@x/f.ts'), '')
  return d
}

// The CLI's stdout is JSON whose shape depends on the command, so the tests
// read it loosely.
type Out = any

function run(
  dir: string | undefined,
  args: string[],
  entries?: unknown,
): { status: number | null; out: Out; stderr: string } {
  const extra: string[] = []
  if (entries !== undefined) {
    const f = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'rn-in-')),
      'e.json',
    )
    fs.writeFileSync(
      f,
      typeof entries === 'string' ? entries : JSON.stringify(entries),
    )
    extra.push(f)
  }
  const r = spawnSync(
    process.execPath,
    [CLI, ...(dir ? ['--workspace', dir] : []), ...args, ...extra],
    {
      encoding: 'utf8',
    },
  )
  let out: Out
  try {
    out = JSON.parse(r.stdout)
  } catch {}
  return { status: r.status, out, stderr: r.stderr }
}

const list = (d: string, ...flags: string[]) => run(d, ['list', ...flags]).out

test('post adds agent threads in one append', () => {
  const d = repo()
  const r = run(
    d,
    ['post'],
    [
      { path: 'a b.ts', line: 3, body: 'one', card: 1 },
      { path: '@x/f.ts', line: 1, body: 'two' },
    ],
  )
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.out.length, 2)
  const threads = list(d)
  assert.equal(threads.length, 2)
  assert.deepEqual(
    threads.map((t: Out) => [t.path, t.line, t.card, t.by]),
    [
      ['a b.ts', 3, 1, 'agent'],
      ['@x/f.ts', 1, undefined, 'agent'],
    ],
  )
  assert.equal(store.read(store.repoOf(d).log).length, 2)
})

test('bodies survive newlines, quotes, dollars and Japanese', () => {
  const d = repo()
  const body = '行1\n"quote" $HOME `x`\n- 箇条書き'
  run(d, ['post'], [{ path: 'a b.ts', line: 1, body }])
  assert.equal(list(d)[0].body, body)
})

test('a missing path fails that entry only', () => {
  const d = repo()
  const r = run(
    d,
    ['post'],
    [
      { path: 'nope.ts', line: 1, body: 'x' },
      { path: 'a b.ts', line: 1, body: 'y' },
    ],
  )
  assert.equal(r.status, 1)
  assert.ok(r.out[0].error)
  assert.ok(r.out[1].id)
  assert.equal(list(d).length, 1)
})

test('reply attaches to an existing thread and rejects a missing one', () => {
  const d = repo()
  const [{ id }] = run(
    d,
    ['post'],
    [{ path: 'a b.ts', line: 1, body: 'card' }],
  ).out
  const r = run(
    d,
    ['post'],
    [
      { reply_to: id, body: 'answer' },
      { reply_to: 'gone', body: 'x' },
    ],
  )
  assert.equal(r.status, 1)
  assert.ok(r.out[0].id)
  assert.ok(r.out[1].error)
  assert.equal(list(d)[0].replies.length, 1)
})

test('list --unanswered shows threads whose last word is human', () => {
  const d = repo()
  const [{ id }] = run(
    d,
    ['post'],
    [{ path: 'a b.ts', line: 1, body: 'card' }],
  ).out
  assert.equal(list(d, '--unanswered').length, 0)
  store.append(store.repoOf(d).log, [
    { type: 'reply', by: 'human', thread: id, body: 'why?' },
  ])
  assert.equal(list(d, '--unanswered').length, 1)
})

test('a reply written before a human follow-up leaves the thread unanswered', () => {
  const d = repo()
  const log = store.repoOf(d).log
  const [q1] = store.append(log, [
    { type: 'add', by: 'human', path: 'a b.ts', line: 1, body: 'q1' },
  ])
  const [q2] = store.append(log, [
    { type: 'reply', by: 'human', thread: q1.id, body: 'q2' },
  ])
  const r = run(d, ['post'], [{ reply_to: q1.id, body: 'a1', seen: q1.id }])
  assert.equal(r.status, 0, r.stderr)
  const [t] = list(d, '--unanswered')
  assert.equal(t.id, q1.id)
  assert.equal(t.replies.at(-1).seen, q1.id)
  run(d, ['post'], [{ reply_to: q1.id, body: 'a2', seen: q2.id }])
  assert.equal(list(d, '--unanswered').length, 0)
})

test('a seen outside the thread is an entry error', () => {
  const d = repo()
  const [a, b] = run(
    d,
    ['post'],
    [
      { path: 'a b.ts', line: 1, body: 'one' },
      { path: 'a b.ts', line: 2, body: 'two' },
    ],
  ).out
  const r = run(
    d,
    ['post'],
    [
      { reply_to: a.id, body: 'x', seen: b.id },
      { reply_to: a.id, body: 'y', seen: 5 },
    ],
  )
  assert.equal(r.status, 1, r.stderr)
  assert.ok(r.out[0].error)
  assert.ok(r.out[1].error)
  assert.equal(list(d)[0].replies.length, 0)
})

test('focus needs an existing thread', () => {
  const d = repo()
  const [{ id }] = run(
    d,
    ['post'],
    [{ path: 'a b.ts', line: 1, body: 'card' }],
  ).out
  assert.equal(run(d, ['focus', '--thread', id]).status, 0)
  assert.equal(run(d, ['focus', '--thread', 'gone']).status, 1)
})

test('archive moves the log aside and refuses to overwrite', () => {
  const d = repo()
  assert.deepEqual(run(d, ['archive', '--label', 'abc']).out, {
    archived: null,
  })
  run(d, ['post'], [{ path: 'a b.ts', line: 1, body: 'card' }])
  const r = run(d, ['archive', '--label', 'abc'])
  assert.equal(r.status, 0)
  assert.ok(fs.existsSync(r.out.archived))
  assert.equal(list(d).length, 0)
  run(d, ['post'], [{ path: 'a b.ts', line: 1, body: 'again' }])
  assert.equal(run(d, ['archive', '--label', 'abc']).status, 1)
})

test('usage errors exit 2', () => {
  const d = repo()
  assert.equal(run(undefined, ['list']).status, 2)
  assert.equal(run(d, ['post'], '{}').status, 2)
  assert.equal(run(d, ['bogus']).status, 2)
})

function committed() {
  const d = repo()
  const git = (...a: string[]) => execFileSync('git', ['-C', d, ...a])
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
  return d
}

test('side old is kept, and needs the path at HEAD rather than on disk', () => {
  const d = committed()
  fs.rmSync(path.join(d, 'a b.ts'))
  fs.writeFileSync(path.join(d, 'new.ts'), '')
  const r = run(
    d,
    ['post'],
    [
      { path: 'a b.ts', line: 2, body: 'gone now', side: 'old' },
      { path: 'new.ts', line: 1, body: 'not at HEAD', side: 'old' },
      { path: '@x/f.ts', line: 1, body: 'new side', side: 'new' },
    ],
  )
  assert.equal(r.status, 1, r.stderr)
  assert.ok(r.out[0].id)
  assert.ok(r.out[1].error)
  assert.ok(r.out[2].id)
  assert.deepEqual(
    list(d).map((t: Out) => [t.path, t.side]),
    [
      ['a b.ts', 'old'],
      ['@x/f.ts', undefined],
    ],
  )
})

test('an unknown side is an entry error', () => {
  const d = committed()
  const r = run(d, ['post'], [{ path: 'a b.ts', line: 1, body: 'x', side: 'left' }])
  assert.equal(r.status, 1, r.stderr)
  assert.ok(r.out[0].error)
  assert.equal(list(d).length, 0)
})

test('a non-string path is an entry error, not a crash', () => {
  const d = repo()
  const r = run(d, ['post'], [{ path: 5, line: 1, body: 'x' }])
  assert.equal(r.status, 1, r.stderr)
  assert.ok(r.out[0].error)
})
