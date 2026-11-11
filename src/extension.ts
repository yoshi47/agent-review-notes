import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

import * as nav from './nav'
import * as store from './store'
import type { LogEvent, NewEvent, Side, Thread } from './store'

export interface Repo {
  top: string
  log: string
  base: string
  threads: Map<string, Thread>
  native: Map<string, vscode.CommentThread>
  sig: Map<string, string>
  last?: number
}

interface Location {
  repo: Repo
  path: string
  side: Side
}

interface CardItem {
  repo: Repo
  t: Thread
}

const { Expanded, Collapsed } = vscode.CommentThreadCollapsibleState
export const repos = new Map<string, Repo>() // log path -> repo
export const rendered = new vscode.EventEmitter<Repo>()
let context: vscode.ExtensionContext
let controller: vscode.CommentController
let pending: { repo: Repo; e: LogEvent }[] = []
let timer: NodeJS.Timeout | undefined

const lineRange = (line: number) => new vscode.Range(line - 1, 0, line - 1, 0)
const fileUri = (repo: Repo, rel: string) =>
  vscode.Uri.file(store.absPath(repo.base, rel))
const config = () => vscode.workspace.getConfiguration('reviewNotes')
const where = (t: Thread) =>
  `${t.path}:${t.line}${t.side === 'old' ? ' (old)' : ''}`

// The old side is whatever the git extension opens for the working-tree diff:
// ref '~' (index) on the left for a modified file, 'HEAD' alone for a deleted
// one. Other refs (history, merge stages) are not part of that diff.
const OLD_REFS = new Set(['~', 'HEAD'])

// Threads only show on a document whose URI matches exactly, so this has to
// rebuild the git extension's own toGitUri() for the ref it would pick.
export function uriOf(
  repo: Repo,
  t: Pick<Thread, 'path' | 'side'>,
): vscode.Uri {
  const file = fileUri(repo, t.path)
  if (t.side !== 'old') return file
  const ref = fs.existsSync(file.fsPath) ? '~' : 'HEAD'
  return file.with({
    scheme: 'git',
    query: JSON.stringify({ path: file.fsPath, ref }),
  })
}

const sameUri = (a: vscode.Uri, b: vscode.Uri) =>
  a.scheme === b.scheme && a.fsPath === b.fsPath && a.query === b.query

export function locate(uri: vscode.Uri): Location | undefined {
  let fsPath = uri.fsPath
  let side: Side = 'new'
  if (uri.scheme === 'git') {
    let q: { path?: unknown; ref?: unknown } | null
    try {
      q = JSON.parse(uri.query)
    } catch {
      return undefined
    }
    if (typeof q?.ref !== 'string' || !OLD_REFS.has(q.ref)) return undefined
    if (typeof q.path !== 'string') return undefined
    fsPath = q.path
    side = 'old'
  } else if (uri.scheme !== 'file') return undefined
  const repo = [...repos.values()].find((r) =>
    fsPath.startsWith(r.base + path.sep),
  )
  return repo && { repo, path: store.relPath(repo.base, fsPath), side }
}

function idOf(repo: Repo, native: vscode.CommentThread): string | undefined {
  for (const [id, n] of repo.native) if (n === native) return id
  return undefined
}

function toComments(t: Thread): vscode.Comment[] {
  return [t, ...t.replies].map((c) => ({
    body: new vscode.MarkdownString(c.body ?? ''),
    mode: vscode.CommentMode.Preview,
    author:
      c.by === 'agent'
        ? { name: 'AI', iconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'ai.svg') }
        : { name: 'You', iconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'you.svg') },
    timestamp: new Date(c.at),
  }))
}

function label(t: Thread): string | undefined {
  if (t.card !== undefined) return `Card ${t.card}`
  if (store.waiting(t)) return 'Waiting for AI'
  return undefined
}

const agentReplies = (t: Thread) =>
  t.replies.filter((r) => r.by === 'agent').length

// The extension host only forwards a collapsibleState that differs from its own
// copy, so a thread the user collapsed in the UI needs Collapsed first.
function expand(native: vscode.CommentThread): void {
  native.collapsibleState = Collapsed
  native.collapsibleState = Expanded
}

function collapse(native: vscode.CommentThread): void {
  native.collapsibleState = Expanded
  native.collapsibleState = Collapsed
}

export function render(repo: Repo): void {
  const events = store.read(repo.log)
  const threads = store.fold(events)
  // One malformed thread (hand-edited log) must not stop the rest from showing.
  for (const [id, t] of threads) {
    if (typeof t.path !== 'string' || !Number.isInteger(t.line) || t.line < 1) {
      threads.delete(id)
      continue
    }
    let n = repo.native.get(id)
    const sig = [t.id, ...t.replies.map((r) => r.id)].join(',')
    if (!n) {
      n = controller.createCommentThread(
        uriOf(repo, t),
        lineRange(t.line),
        toComments(t),
      )
      n.collapsibleState = store.initialExpand(t) ? Expanded : Collapsed
      repo.native.set(id, n)
    } else if (repo.sig.get(id) !== sig) {
      n.comments = toComments(t)
      const prev = repo.threads.get(id)
      if (prev && agentReplies(t) > agentReplies(prev)) expand(n)
    }
    // A card just marked read is done: fold it so the next one stands out.
    const was = repo.threads.get(id)
    if (was && !was.read && t.read && config().get('collapseOnRead', true))
      collapse(n)
    // VS Code folds a resolved thread itself under comments.collapseOnResolve
    // and does so after any state this sends, so off cannot keep it open.
    if (was && !was.resolved && t.resolved && config().get('collapseOnResolve', false))
      collapse(n)
    repo.sig.set(id, sig)
    const card =
      t.card === undefined ? '' : t.read ? '-card-read' : '-card-unread'
    n.contextValue = (t.resolved ? 'resolved' : 'unresolved') + card
    n.state = t.resolved
      ? vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved
    n.label = label(t)
  }
  for (const [id, n] of repo.native) {
    if (threads.has(id)) continue
    n.dispose()
    repo.native.delete(id)
    repo.sig.delete(id)
  }
  repo.threads = threads

  const key = `mark:${repo.log}`
  const { news, mark } = store.fresh(
    events,
    context.workspaceState.get<store.Mark>(key),
  )
  context.workspaceState.update(key, mark)
  const writes = news.filter(
    (e) => e.by === 'agent' && (e.type === 'add' || e.type === 'reply'),
  )
  if (writes.length) queueNotice(repo, writes)
  const focus = news.filter((e) => e.type === 'focus').at(-1)
  if (focus?.type === 'focus') reveal(repo, focus.thread)
  rendered.fire(repo)
}

function queueNotice(repo: Repo, writes: LogEvent[]): void {
  pending.push(...writes.map((e) => ({ repo, e })))
  clearTimeout(timer)
  timer = setTimeout(notify, config().get('notifyDelaySeconds', 2) * 1000)
}

async function notify(): Promise<void> {
  const items = pending
  pending = []
  if (!items.length) return
  const { repo, e } = items[0]
  const threadId = e.type === 'add' ? e.id : e.thread
  const t = repo.threads.get(threadId)
  const message =
    items.length > 1 || !t
      ? `AI wrote ${items.length} comments`
      : `AI ${e.type === 'reply' ? 'replied' : 'commented'} on ${where(t)}`
  if ((await vscode.window.showInformationMessage(message, 'Open')) === 'Open')
    reveal(repo, threadId)
}

export async function reveal(repo: Repo, id: string): Promise<void> {
  const t = repo.threads.get(id)
  const n = repo.native.get(id)
  if (!t || !n) return
  const uri = uriOf(repo, t)
  // The left side of a diff never becomes the active editor, so look through
  // the visible ones too (the active one first, in case of splits).
  const opened = () =>
    [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors].find(
      (e) => e && sameUri(e.document.uri, uri),
    )
  try {
    if (config().get('openInDiff', true))
      await vscode.commands.executeCommand(
        'git.openChange',
        fileUri(repo, t.path),
      )
  } catch {}
  // git.openChange silently opens nothing for a file with no change (or before
  // the git extension has scanned the repo), so fall back to the plain editor.
  try {
    if (!opened()) await vscode.window.showTextDocument(uri)
  } catch {
    return
  }
  const editor = opened()
  if (editor) {
    const r = lineRange(t.line)
    editor.selection = new vscode.Selection(r.start, r.start)
    editor.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }
  expand(n)
}

export function write(repo: Repo, events: NewEvent[]): LogEvent[] | undefined {
  try {
    return store.append(repo.log, events)
  } catch (e) {
    vscode.window.showErrorMessage(
      `Agent Review Notes: could not write (${e instanceof Error ? e.message : String(e)})`,
    )
    return undefined
  }
}

type ThreadAction = 'resolve' | 'reopen' | 'read' | 'unread'

function onThread(
  native: vscode.CommentThread | undefined,
  type: ThreadAction,
): void {
  const repo = native && locate(native.uri)?.repo
  const id = repo && idOf(repo, native)
  if (!repo || !id) return
  if (write(repo, [{ type, by: 'human', thread: id }])) render(repo)
}

async function archiveReview(): Promise<void> {
  const withThreads = [...repos.values()].filter((r) => r.threads.size)
  if (!withThreads.length) {
    vscode.window.showInformationMessage('Agent Review Notes: nothing to archive')
    return
  }
  const editor = vscode.window.activeTextEditor
  const here = editor && locate(editor.document.uri)?.repo
  let repo = here && withThreads.includes(here) ? here : withThreads[0]
  if (withThreads.length > 1 && !(here && withThreads.includes(here))) {
    const picked = await vscode.window.showQuickPick(
      withThreads.map((r) => ({ label: path.basename(r.top), description: r.top, repo: r })),
      { placeHolder: 'Repository to archive the review of' },
    )
    if (!picked) return
    repo = picked.repo
  }
  const n = repo.threads.size
  const label = new Date().toISOString().replace(/[:.]/g, '-')
  const ok = await vscode.window.showWarningMessage(
    `Archive ${n} thread${n === 1 ? '' : 's'} in ${path.basename(repo.top)}?`,
    {
      modal: true,
      detail: `They disappear from the editor. The log is kept as review-notes.${label}.jsonl in the git directory.`,
    },
    'Archive',
  )
  if (ok !== 'Archive') return
  try {
    store.archive(repo.log, label)
  } catch (e) {
    vscode.window.showErrorMessage(
      `Agent Review Notes: could not archive (${e instanceof Error ? e.message : String(e)})`,
    )
    return
  }
  render(repo)
}

function addFolder(folder: vscode.WorkspaceFolder): void {
  let found: { top: string; log: string }
  try {
    found = store.repoOf(folder.uri.fsPath)
  } catch {
    return
  }
  if (repos.has(found.log)) return
  const repo: Repo = {
    ...found,
    base: store.baseOf(folder.uri.fsPath, found.top),
    threads: new Map(),
    native: new Map(),
    sig: new Map(),
  }
  repos.set(found.log, repo)
  render(repo)
  fs.watchFile(repo.log, { interval: 750 }, () => render(repo))
}

export function activate(ctx: vscode.ExtensionContext): void {
  context = ctx
  controller = vscode.comments.createCommentController(
    'review-notes',
    'Agent Review Notes',
  )
  controller.options = { placeHolder: 'Ask a question (Cmd+Enter to send)' }
  controller.commentingRangeProvider = {
    provideCommentingRanges(doc) {
      if (!locate(doc.uri)) return []
      return [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)]
    },
  }
  ctx.subscriptions.push(
    controller,
    rendered,
    vscode.commands.registerCommand(
      'reviewNotes.create',
      (reply: vscode.CommentReply) => {
        const at = locate(reply.thread.uri)
        if (!at || !reply.text.trim() || !reply.thread.range) return
        const { repo } = at
        const add: NewEvent = {
          type: 'add',
          by: 'human',
          path: at.path,
          line: reply.thread.range.start.line + 1,
          body: reply.text,
        }
        if (at.side === 'old') add.side = 'old'
        const [e] = write(repo, [add]) ?? []
        if (!e) return
        // Keep VS Code's own thread: recreating it would apply the "AI's turn
        // is over" rule and collapse the question the user just wrote.
        repo.native.set(e.id, reply.thread)
        reply.thread.collapsibleState = Expanded
        render(repo)
      },
    ),
    vscode.commands.registerCommand(
      'reviewNotes.reply',
      (reply: vscode.CommentReply) => {
        const repo = locate(reply.thread.uri)?.repo
        const id = repo && idOf(repo, reply.thread)
        if (!repo || !id || !reply.text.trim()) return
        if (
          write(repo, [
            { type: 'reply', by: 'human', thread: id, body: reply.text },
          ])
        )
          render(repo)
      },
    ),
    vscode.commands.registerCommand(
      'reviewNotes.resolve',
      (t: vscode.CommentThread) => onThread(t, 'resolve'),
    ),
    vscode.commands.registerCommand(
      'reviewNotes.reopen',
      (t: vscode.CommentThread) => onThread(t, 'reopen'),
    ),
    vscode.commands.registerCommand(
      'reviewNotes.markRead',
      (t: vscode.CommentThread) => onThread(t, 'read'),
    ),
    vscode.commands.registerCommand(
      'reviewNotes.markUnread',
      (t: vscode.CommentThread) => onThread(t, 'unread'),
    ),
    vscode.commands.registerCommand('reviewNotes.copyCliCommand', async () => {
      const cli = `node "${ctx.asAbsolutePath(path.join('out', 'bin', 'review-notes.js'))}"`
      await vscode.env.clipboard.writeText(cli)
      vscode.window.showInformationMessage(`Copied: ${cli}`)
    }),
    vscode.commands.registerCommand('reviewNotes.archive', archiveReview),
  )
  setupCards(ctx)
  for (const folder of vscode.workspace.workspaceFolders ?? [])
    addFolder(folder)
}

function activeRepo(): { repo: Repo; cursor: nav.Cursor | undefined } | undefined {
  const editor = vscode.window.activeTextEditor
  const at = editor && locate(editor.document.uri)
  if (editor && at) {
    const cursor = {
      path: at.path,
      line: editor.selection.active.line + 1,
      side: at.side,
    }
    return { repo: at.repo, cursor }
  }
  const withCards = [...repos.values()].find((r) => nav.cards(r.threads).length)
  return withCards && { repo: withCards, cursor: undefined }
}

function go(
  dir: 1 | -1,
  opts: { unreadOnly?: boolean; wrap?: boolean },
  markLeft: boolean,
): void {
  const here = activeRepo()
  if (!here) return
  const { repo, cursor } = here
  const current = nav.currentCard(repo.threads, cursor, repo.last)
  const target = nav.step(repo.threads, current, dir, opts)
  if (!target) {
    vscode.window.setStatusBarMessage('Agent Review Notes: no more cards', 3000)
    return
  }
  const left = nav.cards(repo.threads).find((t) => t.card === current)
  if (markLeft && left && !left.read)
    write(repo, [{ type: 'read', by: 'human', thread: left.id }])
  repo.last = target.card
  reveal(repo, target.id)
  if (markLeft && left && !left.read) render(repo)
}

function setupCards(ctx: vscode.ExtensionContext): void {
  let hidingRead = false
  const changed = new vscode.EventEmitter<void>()
  const tree = vscode.window.createTreeView<CardItem>('reviewNotes.cards', {
    manageCheckboxStateManually: true,
    treeDataProvider: {
      onDidChangeTreeData: changed.event,
      getChildren: () =>
        [...repos.values()].flatMap((repo) =>
          nav
            .cards(repo.threads)
            .filter((t) => !hidingRead || !t.read)
            .map((t) => ({ repo, t })),
        ),
      getTreeItem: ({ repo, t }) => {
        const head = (t.body ?? '')
          .replace(/\s+/g, ' ')
          .replace(/^#+ /, '')
          .slice(0, 40)
        const item = new vscode.TreeItem(
          `#${t.card} ${t.path}:L${t.line}${t.side === 'old' ? ' (old)' : ''} — ${head}`,
        )
        item.checkboxState = t.read
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked
        item.command = {
          command: 'reviewNotes.revealCard',
          title: 'Open',
          arguments: [repo.log, t.id],
        }
        return item
      },
    },
  })
  const decorationsChanged = new vscode.EventEmitter<undefined>()
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10,
  )
  status.command = 'reviewNotes.nextUnread'
  const refresh = () => {
    changed.fire()
    decorationsChanged.fire(undefined)
    let unread = 0
    let total = 0
    for (const r of repos.values()) {
      const c = nav.counts(r.threads)
      unread += c.unread
      total += c.total
    }
    status.text = `$(comment-discussion) Cards ${unread} unread / ${total}`
    if (total) status.show()
    else status.hide()
  }
  const setHiding = (v: boolean) => {
    hidingRead = v
    vscode.commands.executeCommand('setContext', 'reviewNotes.hidingRead', v)
    changed.fire()
  }
  ctx.subscriptions.push(
    tree,
    changed,
    status,
    decorationsChanged,
    rendered.event(refresh),
    tree.onDidChangeCheckboxState((e) => {
      const touched = new Set<Repo>()
      for (const [{ repo, t }, state] of e.items) {
        const type =
          state === vscode.TreeItemCheckboxState.Checked ? 'read' : 'unread'
        if (write(repo, [{ type, by: 'human', thread: t.id }]))
          touched.add(repo)
      }
      for (const repo of touched) render(repo)
    }),
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: decorationsChanged.event,
      provideFileDecoration(uri) {
        const at = uri.scheme === 'file' ? locate(uri) : undefined
        const n = at && nav.unreadByPath(at.repo.threads).get(at.path)
        // Badges longer than two characters are rejected by VS Code.
        return n
          ? {
              badge: n > 99 ? '99' : String(n),
              tooltip: `${n} unread card${n === 1 ? '' : 's'}`,
            }
          : undefined
      },
    }),
    vscode.commands.registerCommand(
      'reviewNotes.revealCard',
      (log: string, id: string) => {
        const repo = repos.get(log)
        const t = repo?.threads.get(id)
        if (!repo || !t) return
        repo.last = t.card
        reveal(repo, id)
      },
    ),
    vscode.commands.registerCommand('reviewNotes.nextCard', () =>
      go(1, {}, true),
    ),
    vscode.commands.registerCommand('reviewNotes.prevCard', () =>
      go(-1, {}, false),
    ),
    vscode.commands.registerCommand('reviewNotes.nextUnread', () =>
      go(1, { unreadOnly: true, wrap: true }, false),
    ),
    vscode.commands.registerCommand('reviewNotes.hideRead', () =>
      setHiding(true),
    ),
    vscode.commands.registerCommand('reviewNotes.showRead', () =>
      setHiding(false),
    ),
  )
  refresh()
}

export function deactivate(): void {
  clearTimeout(timer)
  for (const log of repos.keys()) fs.unwatchFile(log)
}
