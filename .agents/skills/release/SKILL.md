---
name: release
description: roadmap-toolのリリースプロセスを実行する。バージョンのバンプ、ブランチ作成、コミット、タグ付け、プッシュ、PR作成を行う。
---

# Release スキル

`release.yml` ワークフローと同等のリリース処理をローカルで実行します。タグをプッシュすると `cd.yml` が自動的にトリガーされ、マルチプラットフォームバイナリのビルドと GitHub Release の作成が行われます。

## 実行前の確認事項

開始前に以下を確認してください:

1. 作業ブランチが `main` であること（`git branch --show-current` で確認）
2. ローカルの `main` がリモートと同期していること（`git status` でクリーンな状態）
3. バージョンタイプ（`patch` / `minor` / `major`）をユーザーに確認する

**mainブランチ以外で実行しようとしている場合は中断し、ユーザーに `main` へ切り替えるよう伝えてください。**

**必ずユーザーに確認を取ってから次のステップへ進んでください。**

## 手順

### ステップ 1: 現在のバージョンを確認する

```bash
node -p "require('./package.json').version"
```

現在のバージョンと、バンプ後のバージョン（例: `0.2.2` → `0.2.3`）をユーザーに示し、続行の確認を取ること。

### ステップ 2: バージョンをバンプする

`{type}` は `patch`、`minor`、`major` のいずれか:

```bash
npm version {type} --no-git-tag-version
```

バンプ後の新しいバージョンを取得する:

```bash
node -p "require('./package.json').version"
```

以降の手順では `{version}` をこの値（例: `0.2.3`）に置き換えてください。

### ステップ 3: リリースブランチを作成する

```bash
git checkout -b release/v{version}
```

### ステップ 4: コミットする

```bash
git add package.json
git commit -m "chore: release v{version}"
```

### ステップ 5: タグを作成する

```bash
git tag "v{version}"
```

### ステップ 6: ブランチとタグをプッシュする（破壊的操作 — 再確認）

**この操作は取り消せません。** プッシュ前にユーザーへ最終確認を求めること:

- プッシュするブランチ: `release/v{version}`
- プッシュするタグ: `v{version}`
- タグのプッシュにより `cd.yml` が自動起動し、マルチプラットフォームビルドと GitHub Release が作成される

確認が取れたらプッシュする:

```bash
git push -u origin release/v{version}
git push origin "v{version}"
```

### ステップ 7: プルリクエストを作成する

GitHub MCP ツール (`mcp__github__create_pull_request`) が利用可能な場合はそちらを使用する。利用できない場合は `gh` CLI を使う。

**MCP ツールを使う場合:**

`mcp__github__create_pull_request` を次のパラメータで呼び出す:
- `owner`: `mpppk`
- `repo`: `roadmap-tool`
- `title`: `chore: release v{version}`
- `body`: `Automated version bump for release v{version}.`
- `head`: `release/v{version}`
- `base`: `main`

**gh CLI を使う場合（フォールバック）:**

```bash
gh pr create \
  --title "chore: release v{version}" \
  --body "Automated version bump for release v{version}." \
  --base main \
  --head release/v{version}
```

## 完了後

- 作成した PR の URL をユーザーに伝えること
- タグのプッシュにより `cd.yml` がすでにトリガーされていることを案内すること
- GitHub Actions の進捗は https://github.com/mpppk/roadmap-tool/actions で確認できる

## エラー処理

| 状況 | 対応 |
|------|------|
| `main` ブランチ以外で実行しようとしている | 中断してユーザーに `main` へ切り替えるよう伝える |
| タグが既に存在する（`git tag` でエラー） | 処理を中断し、`git tag -d v{version}` で削除してからリトライするよう案内する |
| ブランチが既に存在する（`git checkout -b` でエラー） | 処理を中断し、状況をユーザーに確認する |
| `git push` に失敗した | タグをローカルで削除（`git tag -d v{version}`）してからリトライするか中断する |
| `npm version` でエラー | `package.json` の状態を確認し、ユーザーに報告する |
