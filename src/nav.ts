// Card order across files. Cards are numbered by the agent, so "next" means
// the next number, not the next line: a cursor between cards has no position
// of its own and falls back to the last card a command landed on.

import type { Side, Thread } from './store'

type CardLike = Pick<Thread, 'id' | 'path' | 'line' | 'card' | 'side' | 'read'>
type Card<T extends CardLike> = T & { card: number }

export interface Cursor {
  path: string
  line: number
  side?: Side
}

export const cards = <T extends CardLike>(threads: Map<string, T>): Card<T>[] =>
  [...threads.values()]
    .filter((t): t is Card<T> => t.card !== undefined)
    .sort((a, b) => a.card - b.card)

export function currentCard(
  threads: Map<string, CardLike>,
  cursor: Cursor | undefined,
  last?: number,
): number | undefined {
  const here =
    cursor &&
    cards(threads).find(
      (t) =>
        t.path === cursor.path &&
        t.line === cursor.line &&
        (t.side === 'old') === (cursor.side === 'old'),
    )
  return here ? here.card : last
}

export function step<T extends CardLike>(
  threads: Map<string, T>,
  current: number | undefined,
  dir: 1 | -1,
  { unreadOnly = false, wrap = false } = {},
): Card<T> | undefined {
  let list = cards(threads)
  if (dir < 0) list = list.reverse()
  const ok = (t: Card<T>) => !unreadOnly || !t.read
  const ahead = (t: Card<T>) =>
    current === undefined || (dir > 0 ? t.card > current : t.card < current)
  return (
    list.find((t) => ahead(t) && ok(t)) ?? (wrap ? list.find(ok) : undefined)
  )
}

export function counts(threads: Map<string, CardLike>): {
  unread: number
  total: number
} {
  const all = cards(threads)
  return { unread: all.filter((t) => !t.read).length, total: all.length }
}

export function unreadByPath(threads: Map<string, CardLike>): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of cards(threads))
    if (!t.read) m.set(t.path, (m.get(t.path) ?? 0) + 1)
  return m
}
