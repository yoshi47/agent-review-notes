import * as assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import * as store from './store'
import type { LogEvent } from './store'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rn-'))
const logIn = (dir: string) => path.join(dir, 'review-notes.jsonl')

test('append fills id and at, and read returns the same events', () => {
  const f = logIn(tmp())
  const written = store.append(f, [
    { type: 'add', by: 'agent', path: 'a.ts', line: 1, body: 'x' },
    { type: 'add', by: 'agent', path: 'b.ts', line: 2, body: 'y' },
  ])
  assert.equal(written.length, 2)
  assert.ok(written[0].id && written[0].at)
  assert.deepEqual(store.read(f), written)
  assert.equal(fs.readFileSync(f, 'utf8').split('\n').length, 3)
})

test('append after an unterminated fragment keeps the new event readable', () => {
  const f = logIn(tmp())
  fs.writeFileSync(f, '{"type":"add"')
  const [e] = store.append(f, [
    { type: 'add', by: 'agent', path: 'a.ts', line: 1, body: 'x' },
  ])
  assert.deepEqual(store.read(f), [e])
})

test('archive renames the log by label, and refuses to overwrite an archive', () => {
  const d = tmp()
  const f = logIn(d)
  assert.equal(store.archive(f, 'r1'), undefined)
  store.append(f, [{ type: 'add', by: 'agent', path: 'a.ts', line: 1, body: 'x' }])
  const to = store.archive(f, 'r1')
  assert.equal(to, path.join(d, 'review-notes.r1.jsonl'))
  assert.equal(fs.existsSync(f), false)
  assert.equal(store.read(to!).length, 1)
  store.append(f, [{ type: 'add', by: 'agent', path: 'b.ts', line: 1, body: 'y' }])
  assert.throws(() => store.archive(f, 'r1'), /already exists/)
  assert.equal(store.read(f).length, 1)
})

test('read ignores a trailing fragment that has no newline yet', () => {
  const f = logIn(tmp())
  const [e] = store.append(f, [
    { type: 'add', by: 'human', path: 'a.ts', line: 1, body: 'x' },
  ])
  fs.appendFileSync(f, '{"type":"reply","thread":')
  assert.deepEqual(store.read(f), [e])
})

test('read of a missing file is empty, and bad lines are skipped', () => {
  const d = tmp()
  assert.deepEqual(store.read(logIn(d)), [])
  fs.writeFileSync(logIn(d), 'not json\n{"type":"add","id":"1"}\n')
  assert.deepEqual(store.read(logIn(d)), [{ type: 'add', id: '1' }])
})

// Fold only reads the fields each event type needs, so the tests spell out
// just those.
const ev = (type: LogEvent['type'], extra: Record<string, unknown>) =>
  ({
    type,
    at: '2026-10-30T00:00:00Z',
    by: 'human',
    ...extra,
  }) as LogEvent

test('fold builds threads from add, reply, resolve, reopen, read, unread', () => {
  const t = (...events: LogEvent[]) => store.fold(events).get('t')!
  const add = ev('add', {
    id: 't',
    by: 'agent',
    path: 'a.ts',
    line: 3,
    body: 'card',
    card: 1,
  })
  const reply = ev('reply', { id: 'r', thread: 't', body: 'q' })
  assert.equal(t(add, reply).replies.length, 1)
  assert.equal(t(add, ev('resolve', { id: 's', thread: 't' })).resolved, true)
  assert.equal(
    t(
      add,
      ev('resolve', { id: 's', thread: 't' }),
      ev('reopen', { id: 'o', thread: 't' }),
    ).resolved,
    false,
  )
  assert.equal(t(add, ev('read', { id: 'd', thread: 't' })).read, true)
  assert.equal(
    t(
      add,
      ev('read', { id: 'd', thread: 't' }),
      ev('unread', { id: 'u', thread: 't' }),
    ).read,
    false,
  )
  assert.equal(t(add).card, 1)
})

test('fold ignores events whose thread does not exist', () => {
  const m = store.fold([
    ev('reply', { id: 'r', thread: 'gone', body: 'q' }),
    ev('resolve', { id: 's', thread: 'gone' }),
    ev('read', { id: 'd', thread: 'gone' }),
    ev('focus', { id: 'f', thread: 'gone' }),
  ])
  assert.equal(m.size, 0)
})

test('unanswered and initialExpand follow whose turn it is', () => {
  const cases: [LogEvent[], number, boolean][] = [
    [
      [ev('add', { id: 't', by: 'agent', path: 'a', line: 1, body: '' })],
      0,
      true,
    ],
    [
      [
        ev('add', { id: 't', by: 'agent', path: 'a', line: 1, body: '' }),
        ev('reply', { id: 'r', thread: 't', body: '' }),
      ],
      1,
      false,
    ],
    [[ev('add', { id: 't', path: 'a', line: 1, body: '' })], 1, false],
    [
      [
        ev('add', { id: 't', path: 'a', line: 1, body: '' }),
        ev('resolve', { id: 's', thread: 't' }),
      ],
      0,
      false,
    ],
  ]
  for (const [events, n, open] of cases) {
    const threads = store.fold(events)
    assert.equal(store.unanswered(threads).length, n)
    assert.equal(store.initialExpand(threads.get('t')!), open)
  }
})

test('fresh returns events after the saved mark, or all when the log changed', () => {
  const es = ['a', 'b', 'c'].map((id) => ({ id }))
  assert.deepEqual(store.fresh(es, undefined).news, es)
  assert.deepEqual(store.fresh(es, { count: 2, lastId: 'b' }).news, [
    { id: 'c' },
  ])
  assert.deepEqual(store.fresh(es, { count: 2, lastId: 'x' }).news, es)
  assert.deepEqual(
    store.fresh(es.slice(0, 1), { count: 3, lastId: 'c' }).news,
    [{ id: 'a' }],
  )
  assert.deepEqual(store.fresh(es, undefined).mark, { count: 3, lastId: 'c' })
  assert.deepEqual(store.fresh([], undefined).mark, {
    count: 0,
    lastId: undefined,
  })
})

test('concurrent appends of 64KB bodies from two processes all survive', () => {
  const f = logIn(tmp())
  const script =
    `const s=require(${JSON.stringify(path.join(__dirname, 'store'))});` +
    `for(let i=0;i<100;i++)s.append(process.argv[1],[{type:'add',by:'agent',path:'a',line:i+1,body:'x'.repeat(65536)}])`
  const kids = [0, 1].map(() =>
    spawn(process.execPath, ['-e', script, f]),
  )
  return Promise.all(kids.map((k) => new Promise((r) => k.on('exit', r)))).then(
    () => {
      assert.equal(store.read(f).length, 200)
    },
  )
})

test('repoOf returns the real top level and the log in the git dir', () => {
  const d = tmp()
  execFileSync('git', ['init', '-q', d])
  const real = fs.realpathSync(d)
  assert.deepEqual(store.repoOf(d), {
    top: real,
    log: path.join(real, '.git', 'review-notes.jsonl'),
  })
})

test('repoOf throws outside a repository', () => {
  assert.throws(() => store.repoOf(tmp()))
})

test('relPath and absPath round-trip, including spaces and @', () => {
  for (const rel of ['x/a b.ts', '@proone/f.ts']) {
    assert.equal(store.relPath('/w/r', store.absPath('/w/r', rel)), rel)
  }
  assert.equal(store.absPath('/w/r', 'x/a b.ts'), '/w/r/x/a b.ts')
})

test('baseOf maps a sub-folder or a symlinked folder onto the repository top', () => {
  const d = fs.realpathSync(tmp())
  fs.mkdirSync(path.join(d, 'r/apps'), { recursive: true })
  fs.symlinkSync(path.join(d, 'r'), path.join(d, 'link'))
  assert.equal(
    store.baseOf(path.join(d, 'r/apps'), path.join(d, 'r')),
    path.join(d, 'r'),
  )
  assert.equal(
    store.baseOf(path.join(d, 'link'), path.join(d, 'r')),
    path.join(d, 'link'),
  )
  assert.equal(
    store.baseOf(path.join(d, 'link/apps'), path.join(d, 'r')),
    path.join(d, 'link'),
  )
})
