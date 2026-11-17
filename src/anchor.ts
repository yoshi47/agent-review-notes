// Where a line written against one version of a file is in another version.
// Lines are matched by a line diff (Myers), not searched for by content: a
// line that reads the same elsewhere, like `}` or `return undefined`, is not
// the same line.

export interface Followed {
  line: number // 1-based, in the newer text
  changed: boolean // the line itself was edited or removed
}

// Past this many inserted plus removed lines the diff is not worth its cost,
// and the files have little left in common anyway.
const MAX_EDITS = 1000

export const linesOf = (text: string): string[] => text.split(/\r?\n/)

type Op = '=' | '-' | '+'

// The edit script from a to b, or undefined past MAX_EDITS.
function diff(a: string[], b: string[]): Op[] | undefined {
  const n = a.length
  const m = b.length
  const off = n + m + 1
  const v = new Int32Array(2 * off + 1)
  // trace[d] is v[-d..d] as it was before step d.
  const trace: Int32Array[] = []
  for (let d = 0; d <= Math.min(n + m, MAX_EDITS); d++) {
    trace.push(v.slice(off - d, off + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])
          ? v[off + k + 1]
          : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(trace, d, n, m)
    }
  }
  return undefined
}

function backtrack(trace: Int32Array[], last: number, n: number, m: number): Op[] {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = last; d > 0; d--) {
    const row = trace[d]
    const get = (k: number) => row[k + d]
    const k = x - y
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = get(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push('=')
      x--
      y--
    }
    ops.push(down ? '+' : '-')
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    ops.push('=')
    x--
    y--
  }
  return ops.reverse()
}

const clamp = (line: number, count: number) =>
  Math.min(Math.max(line, 1), Math.max(count, 1))

// A changed line goes to the first line of the change that replaced it, so the
// thread stays next to the code that now stands in its place.
export function follow(before: string[], after: string[], line: number): Followed {
  const target = line - 1
  if (target >= before.length)
    return { line: clamp(line + after.length - before.length, after.length), changed: false }
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head])
    head++
  if (target < head) return { line, changed: false }
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++
  if (target >= before.length - tail)
    return { line: line + after.length - before.length, changed: false }
  const ops = diff(
    before.slice(head, before.length - tail),
    after.slice(head, after.length - tail),
  )
  if (!ops) return { line: clamp(line, after.length), changed: true }
  let i = head
  let j = head
  let hunk: number | undefined
  for (const op of ops) {
    if (op === '=') {
      if (i === target) return { line: j + 1, changed: false }
      i++
      j++
      hunk = undefined
      continue
    }
    hunk ??= j
    if (op === '+') j++
    else if (i++ === target) return { line: clamp(hunk + 1, after.length), changed: true }
  }
  // Unreachable: target lies inside the diffed middle, so some op covers it.
  return { line: clamp(line, after.length), changed: true }
}
