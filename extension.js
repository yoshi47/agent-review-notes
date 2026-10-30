const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

const nav = require('./nav')
const store = require('./store')

const { Expanded, Collapsed } = vscode.CommentThreadCollapsibleState
const repos = new Map() // log path -> repo
const rendered = new vscode.EventEmitter()
let context
let controller
let pending = []
let timer

const lineRange = (line) => new vscode.Range(line - 1, 0, line - 1, 0)
const uriOf = (repo, rel) => vscode.Uri.file(store.absPath(repo.base, rel))
const config = () => vscode.workspace.getConfiguration('reviewNotes')

function repoForUri(uri) {
  if (uri.scheme !== 'file') return undefined
  return [...repos.values()].find((r) =>
    uri.fsPath.startsWith(r.base + path.sep),
  )
}

function idOf(repo, native) {
  for (const [id, n] of repo.native) if (n === native) return id
  return undefined
}

function toComments(t) {
  return [t, ...t.replies].map((c) => ({
    body: new vscode.MarkdownString(c.body ?? ''),
    mode: vscode.CommentMode.Preview,
    author:
      c.by === 'agent'
        ? { name: 'AI', iconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'ai.svg') }
        : { name: 'あなた', iconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'you.svg') },
    timestamp: new Date(c.at),
  }))
}

function label(t) {
  if (t.card !== undefined) return `カード ${t.card}`
  if (!t.resolved && store.lastBy(t) === 'human') return 'AI の返信待ち'
  return undefined
}

const agentReplies = (t) => t.replies.filter((r) => r.by === 'agent').length

// The extension host only forwards a collapsibleState that differs from its own
// copy, so a thread the user collapsed in the UI needs Collapsed first.
function expand(native) {
  native.collapsibleState = Collapsed
  native.collapsibleState = Expanded
}

function collapse(native) {
  native.collapsibleState = Expanded
  native.collapsibleState = Collapsed
}

function render(repo) {
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
        uriOf(repo, t.path),
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
    if (was && !was.read && t.read) collapse(n)
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
  const { news, mark } = store.fresh(events, context.workspaceState.get(key))
  context.workspaceState.update(key, mark)
  const writes = news.filter(
    (e) => e.by === 'agent' && (e.type === 'add' || e.type === 'reply'),
  )
  if (writes.length) queueNotice(repo, writes)
  const focus = news.filter((e) => e.type === 'focus').at(-1)
  if (focus) reveal(repo, focus.thread)
  rendered.fire(repo)
}

function queueNotice(repo, writes) {
  pending.push(...writes.map((e) => ({ repo, e })))
  clearTimeout(timer)
  timer = setTimeout(notify, config().get('notifyDelaySeconds', 2) * 1000)
}

async function notify() {
  const items = pending
  pending = []
  if (!items.length) return
  const { repo, e } = items[0]
  const threadId = e.type === 'add' ? e.id : e.thread
  const t = repo.threads.get(threadId)
  const message =
    items.length > 1 || !t
      ? `AI が ${items.length} 件書き込みました`
      : `AI が ${t.path}:${t.line} に${e.type === 'reply' ? '返信' : 'コメント'}しました`
  if ((await vscode.window.showInformationMessage(message, '開く')) === '開く')
    reveal(repo, threadId)
}

async function reveal(repo, id) {
  const t = repo.threads.get(id)
  const n = repo.native.get(id)
  if (!t || !n) return
  const uri = uriOf(repo, t.path)
  const opened = () =>
    vscode.window.activeTextEditor?.document.uri.fsPath === uri.fsPath
  try {
    if (config().get('openInDiff', true))
      await vscode.commands.executeCommand('git.openChange', uri)
  } catch {}
  // git.openChange silently opens nothing for a file with no change (or before
  // the git extension has scanned the repo), so fall back to the plain editor.
  try {
    if (!opened()) await vscode.window.showTextDocument(uri)
  } catch {
    return
  }
  const editor = vscode.window.activeTextEditor
  if (editor && editor.document.uri.fsPath === uri.fsPath) {
    const r = lineRange(t.line)
    editor.selection = new vscode.Selection(r.start, r.start)
    editor.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }
  expand(n)
}

function write(repo, events) {
  try {
    return store.append(repo.log, events)
  } catch (e) {
    vscode.window.showErrorMessage(
      `Review Notes: 書き込めませんでした（${e.message}）`,
    )
    return undefined
  }
}

function onThread(native, type) {
  const repo = native && repoForUri(native.uri)
  const id = repo && idOf(repo, native)
  if (!id) return
  if (write(repo, [{ type, by: 'human', thread: id }])) render(repo)
}

function addFolder(folder) {
  let found
  try {
    found = store.repoOf(folder.uri.fsPath)
  } catch {
    return
  }
  if (repos.has(found.log)) return
  const repo = {
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

function activate(ctx) {
  context = ctx
  controller = vscode.comments.createCommentController(
    'review-notes',
    'Review Notes',
  )
  controller.options = { placeHolder: '問いを書く（Cmd+Enter で送信）' }
  controller.commentingRangeProvider = {
    provideCommentingRanges(doc) {
      if (!repoForUri(doc.uri)) return []
      return [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)]
    },
  }
  ctx.subscriptions.push(
    controller,
    rendered,
    vscode.commands.registerCommand('reviewNotes.create', (reply) => {
      const repo = repoForUri(reply.thread.uri)
      if (!repo || !reply.text.trim()) return
      const [e] =
        write(repo, [
          {
            type: 'add',
            by: 'human',
            path: store.relPath(repo.base, reply.thread.uri.fsPath),
            line: reply.thread.range.start.line + 1,
            body: reply.text,
          },
        ]) ?? []
      if (!e) return
      // Keep VS Code's own thread: recreating it would apply the "AI's turn
      // is over" rule and collapse the question the user just wrote.
      repo.native.set(e.id, reply.thread)
      reply.thread.collapsibleState = Expanded
      render(repo)
    }),
    vscode.commands.registerCommand('reviewNotes.reply', (reply) => {
      const repo = repoForUri(reply.thread.uri)
      const id = repo && idOf(repo, reply.thread)
      if (!id || !reply.text.trim()) return
      if (
        write(repo, [
          { type: 'reply', by: 'human', thread: id, body: reply.text },
        ])
      )
        render(repo)
    }),
    vscode.commands.registerCommand('reviewNotes.resolve', (t) =>
      onThread(t, 'resolve'),
    ),
    vscode.commands.registerCommand('reviewNotes.reopen', (t) =>
      onThread(t, 'reopen'),
    ),
    vscode.commands.registerCommand('reviewNotes.markRead', (t) =>
      onThread(t, 'read'),
    ),
    vscode.commands.registerCommand('reviewNotes.markUnread', (t) =>
      onThread(t, 'unread'),
    ),
  )
  setupCards(ctx)
  for (const folder of vscode.workspace.workspaceFolders ?? [])
    addFolder(folder)
}

function activeRepo() {
  const editor = vscode.window.activeTextEditor
  const repo = editor && repoForUri(editor.document.uri)
  if (repo) {
    const cursor = {
      path: store.relPath(repo.base, editor.document.uri.fsPath),
      line: editor.selection.active.line + 1,
    }
    return { repo, cursor }
  }
  const withCards = [...repos.values()].find((r) => nav.cards(r.threads).length)
  return withCards && { repo: withCards, cursor: undefined }
}

function go(dir, opts, markLeft) {
  const here = activeRepo()
  if (!here) return
  const { repo, cursor } = here
  const current = nav.currentCard(repo.threads, cursor, repo.last)
  const target = nav.step(repo.threads, current, dir, opts)
  if (!target)
    return vscode.window.setStatusBarMessage(
      'Review Notes: この先にカードはありません',
      3000,
    )
  const left = nav.cards(repo.threads).find((t) => t.card === current)
  if (markLeft && left && !left.read)
    write(repo, [{ type: 'read', by: 'human', thread: left.id }])
  repo.last = target.card
  reveal(repo, target.id)
  if (markLeft && left && !left.read) render(repo)
}

function setupCards(ctx) {
  let hidingRead = false
  const changed = new vscode.EventEmitter()
  const tree = vscode.window.createTreeView('reviewNotes.cards', {
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
          `#${t.card} ${t.path}:L${t.line} — ${head}`,
        )
        item.checkboxState = t.read
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked
        item.command = {
          command: 'reviewNotes.revealCard',
          title: '開く',
          arguments: [repo.log, t.id],
        }
        return item
      },
    },
  })
  const decorationsChanged = new vscode.EventEmitter()
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
    status.text = `$(comment-discussion) カード 未読 ${unread} / 全 ${total}`
    if (total) status.show()
    else status.hide()
  }
  const setHiding = (v) => {
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
      const touched = new Set()
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
        const repo = repoForUri(uri)
        const n =
          repo &&
          nav
            .unreadByPath(repo.threads)
            .get(store.relPath(repo.base, uri.fsPath))
        // Badges longer than two characters are rejected by VS Code.
        return n
          ? {
              badge: n > 99 ? '99' : String(n),
              tooltip: `未読のカード ${n} 件`,
            }
          : undefined
      },
    }),
    vscode.commands.registerCommand('reviewNotes.revealCard', (log, id) => {
      const repo = repos.get(log)
      const t = repo?.threads.get(id)
      if (!t) return
      repo.last = t.card
      reveal(repo, id)
    }),
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

function deactivate() {
  clearTimeout(timer)
  for (const log of repos.keys()) fs.unwatchFile(log)
}

module.exports = {
  activate,
  deactivate,
  repos,
  rendered,
  reveal,
  render,
  write,
}
