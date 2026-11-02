// Runs inside the extension host (see run.js). What only a real VS Code can
// tell: whether the URIs this extension builds for the old side are the ones
// the git extension actually opens, since a thread shows only on an exact match.

const assert = require('node:assert/strict')
const path = require('node:path')
const vscode = require('vscode')

const store = require('../store')

const ws = process.env.REVIEW_NOTES_WS
const file = (rel) => vscode.Uri.file(path.join(ws, rel))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(what, get, ms = 15000) {
  const end = Date.now() + ms
  for (;;) {
    const v = get()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

const gitEditor = (rel) =>
  vscode.window.visibleTextEditors.find(
    (e) =>
      e.document.uri.scheme === 'git' &&
      e.document.uri.fsPath === file(rel).fsPath,
  )

async function openChange(rel) {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await vscode.commands.executeCommand('git.openChange', file(rel))
  return until(`the old side of ${rel}`, () => gitEditor(rel))
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

let ext
let repo

test('the old side of a modified file matches the left side of its diff', async () => {
  const left = await openChange('a.ts')
  const built = ext.uriOf(repo, { path: 'a.ts', line: 1, side: 'old' })
  assert.equal(built.toString(), left.document.uri.toString())
  const at = ext.locate(left.document.uri)
  assert.deepEqual([at.repo, at.path, at.side], [repo, 'a.ts', 'old'])
})

test('the old side of a deleted file matches what the git extension opens', async () => {
  const shown = await openChange('gone.ts')
  const built = ext.uriOf(repo, { path: 'gone.ts', line: 1, side: 'old' })
  assert.equal(built.toString(), shown.document.uri.toString())
  assert.equal(ext.locate(shown.document.uri).side, 'old')
})

test('the working file is the new side, other git refs are no side', () => {
  const at = ext.locate(file('a.ts'))
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
  }
  await vscode.commands.executeCommand('reviewNotes.create', {
    thread,
    text: 'why was this removed?',
  })
  const e = store.read(repo.log).at(-1)
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

async function run() {
  const self = vscode.extensions.getExtension('yoshi47.review-notes')
  await self.activate()
  ext = require('../extension')
  const git = vscode.extensions.getExtension('vscode.git')
  const api = (await git.activate()).getAPI(1)
  await until('git to see both changes', () =>
    api.repositories[0]?.state.workingTreeChanges.length === 2,
  )
  repo = await until('review-notes to watch the repo', () =>
    [...ext.repos.values()][0],
  )
  const failed = []
  for (const t of tests) {
    try {
      await t.fn()
      console.log(`ok   ${t.name}`)
    } catch (e) {
      console.log(`FAIL ${t.name}\n${e.stack}`)
      failed.push(t.name)
    }
  }
  if (failed.length) throw new Error(`${failed.length} of ${tests.length} failed`)
}

module.exports = { run }
