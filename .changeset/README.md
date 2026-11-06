# Changesets

利用者に見える変更を入れる PR には、changeset を1つ添える。

```sh
npx changeset add --minor --message "Added Archive Review to the Command Palette"
```

- `--minor`: 機能の追加。`--patch`: 修正や見た目の変更
- 本文は英語で、利用者向けに1行で書く。`CHANGELOG.md` にそのまま入り、Marketplace / Open VSX の Changelog タブに出る
- テストや CI だけの変更など、利用者に見えない PR には要らない

## 公開までの流れ

1. changeset を含む PR が main に入ると、`version.yml` が「Version Packages」PR を作る（以後、changeset が増えるたびに更新する）
2. その PR は `package.json` / `package-lock.json` のバージョンを上げ、`CHANGELOG.md` に追記し、changeset を消す
3. Version Packages PR をマージすると `package.json` が変わり、`release.yml` が Marketplace / Open VSX に公開する

Version Packages PR は GitHub Actions のトークンで作るため、その PR では CI が自動で走らない。中身はバージョンと変更履歴だけ。
