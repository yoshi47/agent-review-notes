<img src="media/icon.png" width="128" height="128" alt="Agent Review Notes icon">

# Agent Review Notes

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Agent%20Review%20Notes-007ACC)](https://marketplace.visualstudio.com/items?itemName=yoshi47.agent-review-notes)
[![Open VSX](https://img.shields.io/open-vsx/v/yoshi47/agent-review-notes?label=Open%20VSX)](https://open-vsx.org/extension/yoshi47/agent-review-notes)

Ask your AI coding agent about a change, right on the diff in VS Code.

You leave a question on a line. The agent answers in the same thread, and VS Code tells you when it does. The agent can also start threads itself, such as numbered cards that walk you through a pull request.

- Questions on any line: start a thread on the new or the old side of the diff
- Notifications: when the agent comments or replies, a notification takes you to the thread
- Cards in reading order: step through the agent's cards with Next Card, and track which ones you have read
- Works with any agent: the agent writes through a small bundled CLI that takes and returns JSON
- No server: everything goes through one append-only file in the repository's git directory, so the agent can write even before VS Code is open

## How it works

The review lives in `review-notes.jsonl` in the repository's git directory (`git rev-parse --absolute-git-dir`). For a worktree, that is `<main repo>/.git/worktrees/<name>/`.

- The agent appends events through the CLI
- The extension watches the file and draws the threads
- Your actions in VS Code (new threads, replies, resolve, read) are appended to the same file
- Nothing is written to the working tree, and `git worktree remove` deletes the review with the worktree

## What you can comment on

Threads go on the Source Control diff, which compares the working tree with `HEAD`. Whatever shows there as uncommitted changes can be discussed.

- Changes your agent just made: no setup. Open them in the Source Control view and ask on any line, then tell the agent to check its threads (see [the agent loop](#a-typical-agent-loop))
- A pull request: prepare a worktree where the PR shows up as uncommitted changes against its base. How to prepare it is up to your agent or workflow; the extension only reads the diff

## Install

Agent Review Notes needs VS Code 1.80 or later. Install it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=yoshi47.agent-review-notes) or [Open VSX](https://open-vsx.org/extension/yoshi47/agent-review-notes) (for VSCodium, Cursor and other editors that use it), or from the command line:

```sh
code --install-extension yoshi47.agent-review-notes
```

To build a VSIX from this repository instead:

```sh
npx @vscode/vsce package --no-dependencies -o review-notes.vsix
code --install-extension review-notes.vsix
```

## Reading a review

- Cards: Next Card, Previous Card and Next Unread Card are in the Command Palette. Moving past a card with Next Card marks it as read
- Card list: the Agent Review Notes view in the Source Control sidebar lists the cards in order. Uncheck a card to mark it unread again
- Badges: files with unread cards show the unread count in the Explorer and Source Control lists
- Status bar: shows `Cards N unread / M`. Click it to go to the next unread card
- Asking: click `+` next to a line number, write your question, and send it with Cmd+Enter (Ctrl+Enter)
- Moving between threads in one file: VS Code's Alt+F9 / Shift+Alt+F9
- Clearing a review: Archive Review in the Command Palette removes every card and thread at once, after a confirmation. The log is renamed to `review-notes.<date and time>.jsonl` in the git directory, like the CLI's `archive`

A thread opens when it is your turn to read: when the agent has posted or replied last and it is not resolved. Threads waiting for the agent stay collapsed.

## For agents: the CLI

The CLI ships inside the extension at `out/bin/review-notes.js` and runs with Node.js (tested with Node.js 24). Run Agent Review Notes: Copy CLI Command from the Command Palette to copy `node "<extension folder>/out/bin/review-notes.js"`, and give it to your agent. The folder name contains the extension version, so copy it again after an update.

The examples below write the CLI path as `$CLI`:

```sh
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

### A typical agent loop

1. Optionally, `post` cards and `focus` the first one
2. Poll `list --unanswered` every few seconds. It returns the open threads where you wrote last
3. `post` a reply to each one. The thread drops out of `list --unanswered` until you write again

For example, to print a line whenever the set of unanswered threads changes:

```sh
prev=
while sleep 5; do
  cur=$(node "$CLI" --workspace . list --unanswered | jq -r 'map(.id + ":" + (.replies | length | tostring)) | join(",")')
  [ -n "$cur" ] && [ "$cur" != "$prev" ] && echo "unanswered: $cur"
  prev=$cur
done
```

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
| `reviewNotes.collapseOnRead` | `true` | Collapse a card when it is marked as read |
| `reviewNotes.collapseOnResolve` | `false` | Collapse a thread when it is resolved, even on VS Code 1.80 to 1.82 or with `comments.collapseOnResolve` off. When this is off, VS Code's `comments.collapseOnResolve` decides. To keep resolved threads open, turn that one off |

## Limitations

- Threads do not follow edits. A thread stays on the line number it was written on
- Old-side threads show only in the Source Control diff of the working tree, not in other `git:` views such as file history
- If the same worktree is open in two windows, both show the notification

## Development

```sh
npm install
npm run compile       # src/ (TypeScript) -> out/
npm test              # store, navigation and CLI
npm run test:vscode   # the extension inside a real VS Code, together with the git extension
```

Both run on every push and pull request in GitHub Actions.

## License

MIT
