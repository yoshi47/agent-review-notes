# Review Notes

AI（review-companion）と人が、ローカルのコードにスレッドで書き込むためのレビュー用コメント。GitHub には何も書かない。

- 保存先: リポジトリの git ディレクトリの `review-notes.jsonl`（追記だけのログ）。worktree を消すと一緒に消える
- AI は同梱の CLI で書く: `node bin/review-notes.js --workspace <dir> post|focus|list|archive …`
- 書く: 行番号の横の「+」。送信は Cmd+Enter
- 1ファイルの中のスレッド間の移動は、VS Code 標準の Alt+F9 / Shift+Alt+F9
- 同じ worktree を2つの窓で開くと、通知が両方に出る

入れ方: `npx @vscode/vsce package --no-dependencies -o "$TMPDIR/review-notes.vsix" && code --install-extension "$TMPDIR/review-notes.vsix" --force`（使うプロファイルごとに `--profile ts` などを付けて入れる）
