import * as assert from 'node:assert/strict'
import { test } from 'node:test'

import { follow } from './anchor'

const file = (...lines: string[]) => lines

const base = file('a', 'b', 'c', 'd', 'e', 'f')

test('an unchanged file keeps every line', () => {
  for (let l = 1; l <= base.length; l++)
    assert.deepEqual(follow(base, base, l), { line: l, changed: false })
})

test('lines added above push the line down', () => {
  const after = file('x', 'y', 'a', 'b', 'c', 'd', 'e', 'f')
  assert.deepEqual(follow(base, after, 4), { line: 6, changed: false })
})

test('lines removed above pull the line up', () => {
  const after = file('c', 'd', 'e', 'f')
  assert.deepEqual(follow(base, after, 4), { line: 2, changed: false })
})

test('edits below leave the line where it was', () => {
  const after = file('a', 'b', 'c', 'd', 'E', 'F', 'g')
  assert.deepEqual(follow(base, after, 3), { line: 3, changed: false })
})

test('edits on both sides move the line only by what changed above', () => {
  const after = file('a', 'new', 'b', 'c', 'd', 'E', 'f')
  assert.deepEqual(follow(base, after, 4), { line: 5, changed: false })
})

test('a rewritten line goes to the first line of its replacement', () => {
  const after = file('a', 'b', 'C1', 'C2', 'd', 'e', 'f')
  assert.deepEqual(follow(base, after, 3), { line: 3, changed: true })
  const before = file('a', 'b', 'c', 'd', 'e', 'f')
  const moved = file('x', 'a', 'b', 'D', 'e', 'f')
  assert.deepEqual(follow(before, moved, 4), { line: 4, changed: true })
})

test('a removed line goes to the line that now follows it', () => {
  const after = file('a', 'b', 'd', 'e', 'f')
  assert.deepEqual(follow(base, after, 3), { line: 3, changed: true })
})

test('removing the last lines puts the thread on the new last line', () => {
  const after = file('a', 'b')
  assert.deepEqual(follow(base, after, 6), { line: 2, changed: true })
})

test('a file emptied out still yields line 1', () => {
  assert.deepEqual(follow(base, file(''), 3), { line: 1, changed: true })
})

test('a repeated line is matched by position, not by content', () => {
  const before = file('if (a) {', '}', 'if (b) {', '}', 'end')
  const after = file('if (a) {', '  x()', '}', 'if (b) {', '}', 'end')
  assert.deepEqual(follow(before, after, 4), { line: 5, changed: false })
})

test('a line past the end of the old text stays in range', () => {
  assert.deepEqual(follow(file('a'), file('a', 'b'), 5), { line: 2, changed: false })
})

test('random edits on distinct lines land each kept line on itself', () => {
  let seed = 1
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return seed % n
  }
  let fresh = 0
  for (let round = 0; round < 300; round++) {
    const before = Array.from({ length: 1 + rand(60) }, (_, i) => `l${i}`)
    // Track where each old line ends up while editing, as the expected answer.
    const after: { text: string; from?: number }[] = before.map((text, i) => ({ text, from: i }))
    for (let e = rand(8); e > 0; e--) {
      const at = rand(after.length + 1)
      if (rand(2) && after.length) after.splice(Math.min(at, after.length - 1), 1)
      else after.splice(at, 0, { text: `n${fresh++}` })
    }
    const texts = after.map((a) => a.text)
    before.forEach((_, i) => {
      const got = follow(before, texts, i + 1)
      const kept = after.findIndex((a) => a.from === i)
      if (kept >= 0) assert.deepEqual(got, { line: kept + 1, changed: false })
      else {
        assert.equal(got.changed, true)
        assert.ok(got.line >= 1 && got.line <= Math.max(texts.length, 1))
      }
    })
  }
})

test('a large rewrite gives up and keeps the line in range', () => {
  const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`)
  const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`)
  assert.deepEqual(follow([...before, 'z'], [...after, 'z'], 10), {
    line: 10,
    changed: true,
  })
})
