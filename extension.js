const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

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
    author: { name: c.by === 'agent' ? 'AI' : 'あなた' },
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

function render(repo) {
  const events = store.read(repo.log)
  const threads = store.fold(events)
  for (const [id, t] of threads) {
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
  try {
    if (config().get('openInDiff', true))
      await vscode.commands.executeCommand('git.openChange', uri)
    else await vscode.window.showTextDocument(uri)
  } catch {
    await vscode.window.showTextDocument(uri)
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
  for (const folder of vscode.workspace.workspaceFolders ?? [])
    addFolder(folder)
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
