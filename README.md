# Review Notes

Read a pull request together with your AI agent, right on the diff in VS Code.

The agent walks you through the changes with numbered explanation cards. When something is unclear, you ask on that line. The agent answers in the same thread, and VS Code tells you when it does.

- Cards in reading order: step through them with Next Card, and track which ones you have read
- Questions on any line: start a thread on the new or the old side of the diff
- Notifications: when the agent comments or replies, a notification takes you to the thread
- Works with any agent: the agent writes through a small bundled CLI that takes and returns JSON
- No server: everything goes through one append-only file in the repository's git directory, so the agent can write even before VS Code is open

## How it works

The review lives in `review-notes.jsonl` in the repository's git directory (`git rev-parse --absolute-git-dir`). For a worktree, that is `<main repo>/.git/worktrees/<name>/`.

- The agent appends events through the CLI
- The extension watches the file and draws the threads
- Your actions in VS Code (new threads, replies, resolve, read) are appended to the same file
- Nothing is written to the working tree, and `git worktree remove` deletes the review with the worktree

## Setting up a review

Threads are shown in the Source Control diff, which compares the working tree with `HEAD`. To make that diff show a pull request, check out the PR head and move `HEAD` back to the merge base without touching the files:

```sh
git worktree add --detach ../review-123 <pr-head-sha>
cd ../review-123
git reset --mixed "$(git merge-base origin/main HEAD)"
code .
```

The new side of the diff is then the PR, and the old side is the base. A separate worktree per review keeps your own checkout untouched.

## Install

Install Review Notes from the VS Code Marketplace, or build a VSIX from this repository:

```sh
npx @vscode/vsce package --no-dependencies -o review-notes.vsix
code --install-extension review-notes.vsix
```

## Reading a review

- Cards: Next Card, Previous Card and Next Unread Card are in the Command Palette. Moving past a card with Next Card marks it as read
- Card list: the Review Notes view in the Source Control sidebar lists the cards in order. Uncheck a card to mark it unread again
- Badges: files with unread cards show the unread count in the Explorer and Source Control lists
- Status bar: shows `Cards N unread / M`. Click it to go to the next unread card
- Asking: click `+` next to a line number, write your question, and send it with Cmd+Enter (Ctrl+Enter)
- Moving between threads in one file: VS Code's Alt+F9 / Shift+Alt+F9

A thread opens when it is your turn to read: when the agent has posted or replied last and it is not resolved. Threads waiting for the agent stay collapsed.

## For agents: the CLI

The CLI ships inside the extension at `bin/review-notes.js`. Run it with Node.js (tested with Node.js 24):

```sh
CLI=$(ls -d ~/.vscode/extensions/yoshi47.review-notes-*/ | tail -n 1)bin/review-notes.js
node "$CLI" --workspace <repo-or-worktree> <command>
```

`--workspace` can be any directory inside the repository.

| Command | What it does |
|---|---|
| `post <entries.json>` | Appends cards, comments and replies in one write |
| `focus --thread <id>` | Asks VS Code to open that thread |
| `list [--unanswered]` | Prints all threads, or the open ones where you wrote last |
| `archive --label <label>` | Renames the log to `review-notes.<label>.jsonl` to start a new round |

`post` reads a JSON array. Each entry is either a new thread or a reply:

```json
[
  { "path": "src/auth.ts", "line": 42, "card": 1, "body": "This is where the token is checked." },
  { "path": "src/legacy.ts", "line": 10, "side": "old", "body": "This function was removed." },
  { "reply_to": "<thread id>", "body": "It is called from the login handler." }
]
```

- `path`: relative to the repository root
- `line`: 1-based
- `card`: optional reading order, starting at 1
- `side`: `new` (default) or `old`. On the old side, `path` must exist at `HEAD`, so it works for deleted files
- `body`: Markdown

It prints one result per entry, in input order: `{"id": "..."}` or `{"error": "..."}`. An entry with an error is not written.

Exit codes:

- `0`: everything was written
- `1`: some entries or the target thread failed
- `2`: usage error

Put the body in the JSON file rather than in shell arguments, so quoting never breaks it.

A typical loop for an agent:

1. `post` the cards, then `focus` the first one
2. Poll `list --unanswered` for your questions
3. `post` a reply for each one

## The log format

One JSON object per line. Every event has `id`, `at` (ISO time) and `by` (`human` or `agent`).

| `type` | Fields |
|---|---|
| `add` | `path`, `line`, `body`, optional `card` and `side` |
| `reply` | `thread`, `body` |
| `resolve` / `reopen` | `thread` |
| `read` / `unread` | `thread` |
| `focus` | `thread` |

The state is rebuilt by reading the log from the top. Writers only append. A trailing line without a newline is treated as still being written.

## Settings

| Setting | Default | Description |
|---|---|---|
| `reviewNotes.openInDiff` | `true` | Open the Source Control diff when jumping to a thread. Turn off to use the plain editor |
| `reviewNotes.notifyDelaySeconds` | `2` | Seconds of quiet after the agent writes before notifying, so a batch shows one notification |

## Limitations

- Threads do not follow edits. A review worktree is meant to be read, not edited
- Old-side threads show only in the Source Control diff of the working tree, not in other `git:` views such as file history
- If the same worktree is open in two windows, both show the notification

## Development

```sh
npm install
npm test              # store, navigation and CLI
npm run test:vscode   # the extension inside a real VS Code, together with the git extension
```

Both run on every push and pull request in GitHub Actions.

## License

MIT
