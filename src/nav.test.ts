import * as assert from 'node:assert/strict'
import { test } from 'node:test'

import * as nav from './nav'

type T = {
  id: string
  path: string
  line: number
  card?: number
  side?: 'old'
  read: boolean
}

const card = (
  id: string,
  path: string,
  line: number,
  n: number,
  read = false,
): [string, T] => [id, { id, path, line, card: n, read }]
const threads = new Map<string, T>([
  card('c3', 'a.ts', 50, 3),
  card('c1', 'a.ts', 10, 1),
  ['plain', { id: 'plain', path: 'c.ts', line: 1, read: false }],
  card('c2', 'b.ts', 5, 2, true),
])

test('cards are the threads with a card number, in card order', () => {
  assert.deepEqual(
    nav.cards(threads).map((t) => t.id),
    ['c1', 'c2', 'c3'],
  )
})

test('currentCard prefers the card on the cursor line, then the last one reached', () => {
  assert.equal(nav.currentCard(threads, { path: 'a.ts', line: 50 }, 1), 3)
  assert.equal(nav.currentCard(threads, { path: 'a.ts', line: 30 }, 1), 1)
  assert.equal(nav.currentCard(threads, undefined, undefined), undefined)
})

test('currentCard tells the old side of a line from the new side', () => {
  const both = new Map<string, T>([
    ['n', { id: 'n', path: 'a.ts', line: 5, card: 1, read: false }],
    ['o', { id: 'o', path: 'a.ts', line: 5, card: 2, side: 'old', read: false }],
  ])
  assert.equal(nav.currentCard(both, { path: 'a.ts', line: 5, side: 'new' }), 1)
  assert.equal(nav.currentCard(both, { path: 'a.ts', line: 5, side: 'old' }), 2)
})

test('step moves forward and back through card numbers', () => {
  const id = (t: T | undefined) => t?.id
  assert.equal(id(nav.step(threads, undefined, 1)), 'c1')
  assert.equal(id(nav.step(threads, undefined, -1)), 'c3')
  assert.equal(id(nav.step(threads, 1, 1)), 'c2')
  assert.equal(id(nav.step(threads, 3, 1)), undefined)
  assert.equal(id(nav.step(threads, 3, 1, { wrap: true })), 'c1')
  assert.equal(id(nav.step(threads, 2, -1)), 'c1')
  assert.equal(id(nav.step(threads, 1, 1, { unreadOnly: true })), 'c3')
  assert.equal(
    id(nav.step(threads, 3, 1, { unreadOnly: true, wrap: true })),
    'c1',
  )
})

test('counts and unreadByPath only count cards', () => {
  assert.deepEqual(nav.counts(threads), { unread: 2, total: 3 })
  assert.deepEqual([...nav.unreadByPath(threads)], [['a.ts', 2]])
})
