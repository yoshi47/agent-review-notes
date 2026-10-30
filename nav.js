// Card order across files. Cards are numbered by the agent, so "next" means
// the next number, not the next line: a cursor between cards has no position
// of its own and falls back to the last card a command landed on.

const cards = (threads) =>
  [...threads.values()]
    .filter((t) => t.card !== undefined)
    .sort((a, b) => a.card - b.card)

function currentCard(threads, cursor, last) {
  const here =
    cursor &&
    cards(threads).find((t) => t.path === cursor.path && t.line === cursor.line)
  return here ? here.card : last
}

function step(
  threads,
  current,
  dir,
  { unreadOnly = false, wrap = false } = {},
) {
  let list = cards(threads)
  if (dir < 0) list = list.reverse()
  const ok = (t) => !unreadOnly || !t.read
  const ahead = (t) =>
    current === undefined || (dir > 0 ? t.card > current : t.card < current)
  return (
    list.find((t) => ahead(t) && ok(t)) ?? (wrap ? list.find(ok) : undefined)
  )
}

function counts(threads) {
  const all = cards(threads)
  return { unread: all.filter((t) => !t.read).length, total: all.length }
}

function unreadByPath(threads) {
  const m = new Map()
  for (const t of cards(threads))
    if (!t.read) m.set(t.path, (m.get(t.path) ?? 0) + 1)
  return m
}

module.exports = { cards, currentCard, step, counts, unreadByPath }
