// Runs suite.ts (compiled to out/test/suite.js) inside a real VS Code (downloaded into .vscode-test/) on a
// throwaway repository whose change against HEAD is left unstaged, so it shows
// in the working-tree diff.

import { runTests } from '@vscode/test-electron'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function workspace(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rn-vsc-')))
  const git = (...a: string[]) => execFileSync('git', ['-C', d, ...a])
  git('init', '-q')
  const lines = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n'
  fs.writeFileSync(path.join(d, 'a.ts'), lines(10, 'old'))
  fs.writeFileSync(path.join(d, 'gone.ts'), lines(5, 'gone'))
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
  fs.writeFileSync(path.join(d, 'a.ts'), lines(12, 'new'))
  fs.rmSync(path.join(d, 'gone.ts'))
  return d
}

async function main(): Promise<void> {
  const ws = workspace()
  try {
    await runTests({
      // Unset runs the latest stable; CI also runs the oldest version engines allows.
      version: process.env.VSCODE_TEST_VERSION,
      extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
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
