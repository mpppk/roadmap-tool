# roadmap-tool

チームのリソース配分・ロードマップ計画を管理するツールです。フィーチャー（作業項目）・チームメンバー・四半期を登録し、各メンバーのキャパシティを機能ごとに配分することで、チーム全体の稼働状況を可視化・計画できます。

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
| `feature_quarters` | ある機能に対して特定の四半期で確保する月次キャパシティ合計 |
| `member_allocations` | あるメンバーが特定の機能・四半期に充てる月次キャパシティ（0〜1） |

**キャパシティの単位**: キャパシティは常に月単位で計算されます（0 = 未稼働、1 = フル稼働）。クォーター表示の場合は 3ヶ月分を集計して表示します（最大 3.0）。

**制約**: 1人のメンバーが1ヶ月に配分できるキャパシティの合計は **1.0 以下**。この制約はDBレベルではなくアプリケーション層（`src/router.ts`）で強制されます。

### 配分ロジック

- **合計更新時の比例再配分**: `allocations.updateTotal` で機能の月次キャパシティ合計を変更すると、既存のメンバー配分が新旧比率でスケーリングされ、その後各メンバーの残月次キャパシティでキャップされます。
- **個人配分の上限**: `allocations.updateMemberAllocation` は、他機能への配分済み分を差し引いた残余でサイレントにキャップします（上限 1.0/月）。
- **四半期移動**: `allocations.moveQuarter` はキャパシティ合計とメンバー配分を別四半期へ移動し、メンバーの月次キャップを尊重しながらマージします。
- **メンバーアサイン**: `allocations.assignMember` は指定メンバーを全クォーターに capacity=0 で登録し、フィーチャー展開時に表示されるようにします。
- **メンバー除外**: `allocations.removeMemberFromFeature` は指定フィーチャーからメンバーの全クォーター配分を削除し、`totalCapacity` を再計算します。

## 画面仕様

### Feature キャパシティ画面（`src/CapacityView.tsx`）

チームのキャパシティ配分状況を可視化・編集するメイン画面です。

#### レイアウト

```
┌─────────────────────────────────────────────────────┐
│ Roadmap › Feature キャパシティ                       │ ← ヘッダー
├─────────────┬──────────┬──────────┬──────────┬──────┤
│ Feature     │ 2025 Q1  │ 2025 Q2  │ 2025 Q3  │ …   │ ← スティッキーヘッダー
├─────────────┼──────────┼──────────┼──────────┼──────┤
│ [+] 機能A   │  [2.0]   │  [1.0]   │          │     │ ← Feature行（ヒートマップ）
│   Arai  ×   │  [1.0]   │  [0.5]   │          │     │ ← メンバー行（アサイン済みのみ）
│   Inoue ×   │  [1.0]   │  [0.5]   │          │     │
│   + メンバーを割り当て                              │ ← アサインボタン
├─────────────┼──────────┼──────────┼──────────┼──────┤
│ [+] 機能B   │          │  [1.5]   │  [2.0]   │     │
│   …         │          │          │          │     │
├─────────────┴──────────┴──────────┴──────────┴──────┤
│ + Feature   + Member   + Quarter        ヒント文    │ ← ツールバー
└─────────────────────────────────────────────────────┘
```

#### ヒートマップ表示

- セルの背景色の濃さで人月数を表現します（0 = 白、最大値に近づくほど濃いグレー）
- 濃い背景のセルでは文字色が白に反転します
- 空セル（0）は値を非表示にし、ホバー時に `+` アイコンが現れます

#### Feature 行

| 操作 | 挙動 |
|---|---|
| セルをクリック | 数値入力に切り替わり、人月を直接編集できます |
| Enter / フォーカスアウト | 値を確定し `allocations.updateTotal` でサーバーに保存 |
| Escape | 編集をキャンセル |
| 機能名をクリック | インライン入力でリネーム（Enter / Blur で確定）|
| `[+]` ボタン | メンバー行をインライン展開・折りたたみ |
| 🔴 赤点（overflow-dot） | いずれかの四半期に未アサイン分がある場合に表示 |

合計値を変更すると、既存のメンバー配分が**比率を保ったまま**自動スケーリングされます。特定メンバーの配分が 1.0 を超える場合はそのメンバーを 1.0 で打ち止めにし、超過分は「未アサイン」行に分離します（`allocations.updateTotal` の挙動）。

#### メンバー行（展開時）

Feature 行の `[+]` をクリックすると展開されます。表示されるのは**そのフィーチャーにアサインされたメンバーのみ**です。

| 要素 | 説明 |
|---|---|
| メンバーセル | 個人の月次キャパシティ（0〜1）をヒートマップで表示。クリックで編集 |
| 超過ハイライト | 1.0 超えのセルは赤背景で強調表示 |
| 未アサイン行 | `totalCapacity` - 担当者合計 > 0 の場合に赤イタリックで表示 |
| ホバー時 `×` ボタン | **このフィーチャーから**そのメンバーを削除（確認ダイアログあり）。全クォーターの配分が除去され `totalCapacity` も更新される |
| `+ メンバーを割り当て` | クリックするとドロップダウンが開き、未アサインのメンバーをフィーチャー単位で追加できる。追加直後のキャパシティは 0 |

メンバーセルの値を直接変更した場合は `allocations.updateMemberAllocation` が呼ばれ、そのメンバーの他フィーチャーへの配分を差し引いた残余でサイレントにキャップされます。

#### ツールバー

| ボタン | 挙動 |
|---|---|
| `+ Feature` | 新しいフィーチャーを末尾に追加 |
| `+ Member` | 新しいメンバーを追加（名前はクリックでリネーム可） |
| `+ Quarter` | 直近クォーターの翌四半期を列に追加 |

#### ソースファイル

| ファイル | 役割 |
|---|---|
| `src/CapacityView.tsx` | メインコンポーネント（ヒートマップテーブル・操作ロジック） |
| `src/capacity.css` | キャパシティ画面専用スタイル（CSS 変数・テーブルレイアウト） |

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


## MCP (AI Agent / Codex) 動作確認

`/mcp` エンドポイントを使って、MCP クライアント（例: Codex CLI）から Feature ベースのキャパシティ参照・更新ができます。

### 1. サーバー起動

```sh
bun install
bun run db:migrate
bun dev
```

### 2. MCP initialize

```sh
curl -s http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

### 3. MCP tools/list

```sh
curl -s http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### 4. Feature キャパシティ参照

```sh
curl -s http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"capacity_feature_view","arguments":{}}}'
```

### 5. Feature×Quarter 合計キャパ更新

```sh
curl -s http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"capacity_update_total","arguments":{"featureId":1,"quarterId":1,"totalCapacity":1.5}}}'
```
