// Runs inside the extension host (see run.js). What only a real VS Code can
// tell: whether the URIs this extension builds for the old side are the ones
// the git extension actually opens, since a thread shows only on an exact match;
// and whether the commands and the log watcher reach the real comment threads.
// The tests share one log and run in order.

import * as assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

import type * as Ext from '../extension'
import * as store from '../store'

const ws = process.env.REVIEW_NOTES_WS!
const file = (rel: string) => vscode.Uri.file(path.join(ws, rel))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until<T>(what: string, get: () => T, ms = 15000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = get()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

const gitEditor = (rel: string) =>
  vscode.window.visibleTextEditors.find(
    (e) =>
      e.document.uri.scheme === 'git' &&
      e.document.uri.fsPath === file(rel).fsPath,
  )

async function openChange(rel: string): Promise<vscode.TextEditor> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await vscode.commands.executeCommand('git.openChange', file(rel))
  return until(`the old side of ${rel}`, () => gitEditor(rel))
}

const tests: { name: string; fn: () => unknown }[] = []
const test = (name: string, fn: () => unknown) => tests.push({ name, fn })

let ext: typeof Ext
let repo: Ext.Repo

test('the old side of a modified file matches the left side of its diff', async () => {
  const left = await openChange('a.ts')
  const built = ext.uriOf(repo, { path: 'a.ts', side: 'old' })
  assert.equal(built.toString(), left.document.uri.toString())
  const at = ext.locate(left.document.uri)!
  assert.deepEqual([at.repo, at.path, at.side], [repo, 'a.ts', 'old'])
})

test('the old side of a deleted file matches what the git extension opens', async () => {
  const shown = await openChange('gone.ts')
  const built = ext.uriOf(repo, { path: 'gone.ts', side: 'old' })
  assert.equal(built.toString(), shown.document.uri.toString())
  assert.equal(ext.locate(shown.document.uri)?.side, 'old')
})

test('the working file is the new side, other git refs are no side', () => {
  const at = ext.locate(file('a.ts'))!
  assert.deepEqual([at.path, at.side], ['a.ts', 'new'])
  const history = file('a.ts').with({
    scheme: 'git',
    query: JSON.stringify({ path: file('a.ts').fsPath, ref: 'HEAD~1' }),
  })
  assert.equal(ext.locate(history), undefined)
})

test('a comment written on the left side is stored as the old side', async () => {
  const left = await openChange('a.ts')
  const thread = {
    uri: left.document.uri,
    range: new vscode.Range(6, 0, 6, 0),
    comments: [],
    dispose() {},
  }
  await vscode.commands.executeCommand('reviewNotes.create', {
    thread,
    text: 'why was this removed?',
  })
  const e = store.read(repo.log).at(-1)!
  assert.ok(e.type === 'add')
  assert.deepEqual(
    [e.type, e.by, e.path, e.line, e.side],
    ['add', 'human', 'a.ts', 7, 'old'],
  )
})

test('reveal puts the cursor on the old-side line in the diff', async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  const [e] = store.append(repo.log, [
    { type: 'add', by: 'agent', path: 'a.ts', line: 4, side: 'old', body: 'x', card: 1 },
  ])
  ext.render(repo)
  await ext.reveal(repo, e.id)
  const left = await until('the old side of a.ts', () => gitEditor('a.ts'))
  assert.equal(left.selection.active.line, 3)
})

// The log's last event, read loosely: each test checks the fields it wrote.
const last = () => store.read(repo.log).at(-1) as Record<string, unknown>

test('the thread title buttons log resolve, reopen, read and unread', async () => {
  const [e] = store.append(repo.log, [
    { type: 'add', by: 'agent', path: 'a.ts', line: 2, body: 'y', card: 2 },
  ])
  ext.render(repo)
  const n = repo.native.get(e.id)!
  const press = async (
    command: string,
    type: string,
    contextValue: string,
    state: vscode.CommentThreadState,
  ) => {
    await vscode.commands.executeCommand(command, n)
    assert.deepEqual(
      [last().type, last().by, last().thread],
      [type, 'human', e.id],
    )
    assert.equal(n.contextValue, contextValue)
    assert.equal(n.state, state)
  }
  const { Resolved, Unresolved } = vscode.CommentThreadState
  await press('reviewNotes.markRead', 'read', 'unresolved-card-read', Unresolved)
  await press('reviewNotes.markUnread', 'unread', 'unresolved-card-unread', Unresolved)
  await press('reviewNotes.resolve', 'resolve', 'resolved-card-unread', Resolved)
  await press('reviewNotes.reopen', 'reopen', 'unresolved-card-unread', Unresolved)
})

test('marking read and resolving collapse a thread only as the settings say', async () => {
  const settings = vscode.workspace.getConfiguration('reviewNotes')
  const set = (key: string, v: boolean | undefined) =>
    settings.update(key, v, vscode.ConfigurationTarget.Global)
  const { Expanded, Collapsed } = vscode.CommentThreadCollapsibleState
  // Checked right after the command, before VS Code's own collapse on resolve
  // can come back from the workbench.
  const after = async (command: string, card: number | undefined, line: number) => {
    const [e] = store.append(repo.log, [
      { type: 'add', by: 'agent', path: 'a.ts', line, body: 'w', ...(card ? { card } : {}) },
    ])
    ext.render(repo)
    const n = repo.native.get(e.id)!
    assert.equal(n.collapsibleState, Expanded)
    await vscode.commands.executeCommand(command, n)
    return n.collapsibleState
  }
  try {
    assert.equal(await after('reviewNotes.markRead', 3, 8), Collapsed)
    await set('collapseOnRead', false)
    assert.equal(await after('reviewNotes.markRead', 4, 9), Expanded)
    assert.equal(await after('reviewNotes.resolve', undefined, 10), Expanded)
    await set('collapseOnResolve', true)
    assert.equal(await after('reviewNotes.resolve', undefined, 11), Collapsed)
  } finally {
    await set('collapseOnRead', undefined)
    await set('collapseOnResolve', undefined)
  }
})

test('a reply is logged as human, and a blank one is not logged', async () => {
  const [e] = store.append(repo.log, [
    { type: 'add', by: 'agent', path: 'a.ts', line: 3, body: 'z' },
  ])
  ext.render(repo)
  const n = repo.native.get(e.id)!
  const before = store.read(repo.log).length
  await vscode.commands.executeCommand('reviewNotes.reply', { thread: n, text: '  ' })
  assert.equal(store.read(repo.log).length, before)
  await vscode.commands.executeCommand('reviewNotes.reply', { thread: n, text: 'why?' })
  assert.deepEqual(
    [last().type, last().by, last().thread, last().body],
    ['reply', 'human', e.id, 'why?'],
  )
  assert.equal(n.comments.length, 2)
  assert.equal(n.label, 'Waiting for AI')
})

test('an AI reply appended to the log shows up through the file watcher', async () => {
  const [e] = store.append(repo.log, [
    { type: 'add', by: 'human', path: 'a.ts', line: 5, body: 'q' },
  ])
  ext.render(repo)
  const n = repo.native.get(e.id)!
  assert.equal(n.label, 'Waiting for AI')
  // No render() here: only the watcher on the log may pick this up.
  store.append(repo.log, [{ type: 'reply', by: 'agent', thread: e.id, body: 'a' }])
  await until('the reply to be shown', () => n.comments.length === 2)
  assert.equal(n.label, undefined)
  assert.equal(n.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded)
})

test('next card marks the card being left as read and moves on', async () => {
  // With no editor open, the current card is the last one reached.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  const [one, two] = [1, 2].map((c) =>
    [...repo.threads.values()].find((t) => t.card === c),
  )
  assert.equal(one?.read, false)
  repo.last = 1
  await vscode.commands.executeCommand('reviewNotes.nextCard')
  assert.equal(repo.last, 2)
  assert.equal(repo.threads.get(one!.id)?.read, true)
  await until('card 2 to be revealed', () =>
    vscode.window.visibleTextEditors.find(
      (e) =>
        e.document.uri.toString() === file('a.ts').toString() &&
        e.selection.active.line === two!.line - 1,
    ),
  )
})

test('copy CLI command puts a runnable node command for the bundled CLI on the clipboard', async () => {
  await vscode.commands.executeCommand('reviewNotes.copyCliCommand')
  const copied = await vscode.env.clipboard.readText()
  const cli = path.join(vscode.extensions.getExtension('yoshi47.agent-review-notes')!.extensionPath, 'out', 'bin', 'review-notes.js')
  assert.equal(copied, `node "${cli}"`)
  // The extension host's own binary runs as Node with this flag, so the test
  // does not depend on a node on PATH.
  const r = spawnSync(process.execPath, [cli, '--workspace', ws, 'list'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(Array.isArray(JSON.parse(r.stdout)))
})

// Last: it empties the log the other tests share.
test('archive review moves the log aside and clears every thread', async () => {
  const shown = [...repo.native.values()]
  assert.ok(shown.length)
  const win = vscode.window as { showWarningMessage: unknown }
  const original = win.showWarningMessage
  // The modal confirmation would block the test; answer it as the user would.
  win.showWarningMessage = async () => 'Archive'
  try {
    await vscode.commands.executeCommand('reviewNotes.archive')
  } finally {
    win.showWarningMessage = original
  }
  assert.equal(repo.threads.size, 0)
  assert.equal(repo.native.size, 0)
  const dir = path.dirname(repo.log)
  assert.ok(fs.readdirSync(dir).some((f) => /^review-notes\..+\.jsonl$/.test(f)))
})

export async function run(): Promise<void> {
  const self = vscode.extensions.getExtension('yoshi47.agent-review-notes')!
  await self.activate()
  ext = require('../extension')
  const git = vscode.extensions.getExtension('vscode.git')!
  // The git extension's API has no published types here, only what this needs.
  const api: { repositories: { state: { workingTreeChanges: unknown[] } }[] } =
    (await git.activate()).getAPI(1)
  await until('git to see both changes', () =>
    api.repositories[0]?.state.workingTreeChanges.length === 2,
  )
  repo = await until('review-notes to watch the repo', () =>
    [...ext.repos.values()][0],
  )
  const failed: string[] = []
  for (const t of tests) {
    try {
      await t.fn()
      console.log(`ok   ${t.name}`)
    } catch (e) {
      console.log(`FAIL ${t.name}\n${e instanceof Error ? e.stack : e}`)
      failed.push(t.name)
    }
  }
  if (failed.length) throw new Error(`${failed.length} of ${tests.length} failed`)
}

