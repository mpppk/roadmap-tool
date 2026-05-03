# roadmap-tool

チームのリソース配分・ロードマップ計画を管理するツールです。フィーチャー（作業項目）・チームメンバー・四半期を登録し、各メンバーの工数（人月）を機能ごとに配分することで、チーム全体のキャパシティを可視化・計画できます。

## ドメインモデル

```
features ────┐
             ├── feature_quarters ──── member_allocations ──── members
quarters ────┘
```

| エンティティ | 説明 |
|---|---|
| `features` | 機能・作業項目。name はユニーク |
| `members` | チームメンバー。name はユニーク |
| `quarters` | 計画単位となる四半期。`(year, quarter)` の組み合わせがユニーク |
| `feature_quarters` | ある機能に対して特定の四半期で確保する工数合計（人月） |
| `member_allocations` | あるメンバーが特定の機能・四半期に充てる工数（人月） |

**制約**: 1人のメンバーが1四半期に配分できる合計は **1.0 人月以下**。この制約はDBレベルではなくアプリケーション層（`src/router.ts`）で強制されます。

### 配分ロジック

- **合計更新時の比例再配分**: `allocations.updateTotal` で機能の工数合計を変更すると、既存のメンバー配分が新旧比率でスケーリングされ、その後各メンバーの残キャパシティでキャップされます。
- **個人配分の上限**: `allocations.updateMemberAllocation` は、他機能への配分済み分を差し引いた残余でサイレントにキャップします。
- **四半期移動**: `allocations.moveQuarter` は工数合計とメンバー配分を別四半期へ移動し、メンバーキャップを尊重しながらマージします。

## アーキテクチャ

### 技術スタック

| レイヤー | 技術 |
|---|---|
| ランタイム | [Bun](https://bun.sh) |
| サーバー | `Bun.serve()` |
| フロントエンド | React 19 SPA |
| スタイリング | Tailwind CSS 4 / shadcn/ui |
| API | [oRPC](https://orpc.unnoq.com/)（エンドツーエンド型安全な RPC） |
| データベース | SQLite（`bun:sqlite`） + Drizzle ORM |
| バリデーション | Zod 4 |
| テスト | `bun:test` |
| Lint/Format | Biome |

### リクエストフロー

```
ブラウザ → React (src/App.tsx)
        → orpc クライアント (src/orpc-client.ts) → POST /orpc/<procedure>
        → Bun.serve (src/index.ts) → RPCHandler
        → ルータープロシージャ (src/router.ts) — Zod バリデーション
        → Drizzle ORM → SQLite
```

全 API プロシージャは `src/router.ts` 一ファイルに集約されています。`features` / `members` / `quarters` / `allocations` / `export` の5グループに分かれています。

パスエイリアス: `@/*` → `src/*`

## セットアップ

```sh
bun install          # 依存関係のインストール
bun run db:migrate   # DB マイグレーション（初回 or スキーマ変更後）
bun dev              # 開発サーバー起動（HMR 有効）
```

## 開発コマンド

```sh
bun dev              # 開発サーバー起動（HMR 有効）
bun start            # 本番サーバー起動
bun run build        # 本番ビルド
bun run typecheck    # TypeScript 型チェック（出力なし）
bun run lint         # Biome lint
bun run format       # Biome フォーマット（ファイル書き換え）
bun run check        # lint + format チェック（書き換えなし）
bun test             # テスト実行
```

### データベース操作

```sh
bun run db:generate  # スキーマ変更からマイグレーションファイルを生成
bun run db:migrate   # 未適用マイグレーションを適用
bun run db:push      # スキーマを直接 DB へ反映（開発時のみ）
bun run db:studio    # Drizzle Studio を開く（GUI でデータ確認）
```

## CLI

サーバーが起動している状態で、機能・メンバーの管理をコマンドラインから行えます。

```sh
# 接続先（デフォルト: http://localhost:3000）
export ROADMAP_URL=http://localhost:3000

# features
bun src/cli.ts features list
bun src/cli.ts features add "認証機能"
bun src/cli.ts features rename <id> "認証機能 v2"

# members
bun src/cli.ts members list
bun src/cli.ts members add "Alice"
bun src/cli.ts members rename <id> "Bob"
```

出力はタブ区切りの ID と名前です。

## テスト方針

テストランナーには `bun:test`（Jest 互換 API）を使用しています。

現在のテストファイルは `src/db/schema.test.ts` のみで、インメモリ SQLite を使ってスキーマ制約（ユニーク制約・外部キー制約）を検証しています。ビジネスロジックのテストを追加する場合も同ディレクトリに配置してください。

```sh
bun test                          # 全テスト実行
bun test src/db/schema.test.ts    # 単一ファイル実行
```

## CI

PR マージ前に以下が全て通る必要があります:

```
typecheck → lint → format:check → build
```
