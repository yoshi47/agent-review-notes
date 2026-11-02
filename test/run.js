// Runs test/suite.js inside a real VS Code (downloaded into .vscode-test/) on a
// throwaway repository shaped like a review worktree: HEAD is the base and the
// change is left unstaged, as after review-companion's mixed reset.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runTests } = require('@vscode/test-electron')

function workspace() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rn-vsc-')))
  const git = (...a) => execFileSync('git', ['-C', d, ...a])
  git('init', '-q')
  const lines = (n, tag) =>
    Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n'
  fs.writeFileSync(path.join(d, 'a.ts'), lines(10, 'old'))
  fs.writeFileSync(path.join(d, 'gone.ts'), lines(5, 'gone'))
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
  fs.writeFileSync(path.join(d, 'a.ts'), lines(12, 'new'))
  fs.rmSync(path.join(d, 'gone.ts'))
  return d
}

async function main() {
  const ws = workspace()
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite.js'),
      // Built-in extensions (git) stay on; installed ones would only add noise.
      launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust'],
      extensionTestsEnv: { REVIEW_NOTES_WS: ws },
    })
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
}

main()
