# roadmap-tool

チームのリソース配分・ロードマップ計画を管理するツールです。

## インストール

```sh
curl -fsSL https://install.roadmap.nibo.sh | sh
```

インストール先を指定する場合:

```sh
curl -fsSL https://install.roadmap.nibo.sh | sh -s -- -b ~/.local/bin
```

対応プラットフォーム: macOS (Apple Silicon / Intel)、Linux (x86_64 / arm64)

インストール後:

```sh
roadmap-tool --help
roadmap-tool --version
```

---

チームのリソース配分・ロードマップ計画を管理するツールです。フィーチャー（作業項目）・チームメンバー・四半期を登録し、各メンバーの月次キャパシティを機能ごとに配分することで、チーム全体の稼働状況を可視化・計画できます。

## ドメインモデル

```
epics ──── features ────┐
  │                     ├── feature_months ──── member_month_allocations ──── members
  └── epic_links        └── feature_links
quarters ──── months
```

| エンティティ | 説明 |
|---|---|
| `epics` | Featureをまとめる単位。name はユニーク。description / links / position / 既定フラグを保持 |
| `epic_links` | Epicに紐づく複数リンク。title / url / position を保持 |
| `features` | 機能・作業項目。必ず1つのEpicに属する。name は全体でユニーク。description / position を保持 |
| `feature_links` | Featureに紐づく複数リンク。title / url / position を保持 |
| `members` | チームメンバー。name はユニーク |
| `quarters` | 四半期グループ。`(year, quarter)` の組み合わせがユニーク |
| `months` | 計画の最小単位となる月。`(year, month)` の組み合わせがユニークで、必ず四半期に属する |
| `feature_months` | ある機能に対して特定の月で確保するキャパシティ合計 |
| `member_month_allocations` | あるメンバーが特定の機能・月に充てるキャパシティ（0〜1） |

**キャパシティの単位**: キャパシティは月単位で保存されます（0 = 未稼働、1 = フル稼働）。四半期表示では配下3ヶ月分を合計して表示します。

**制約**: 1人のメンバーが1ヶ月に配分できるキャパシティの合計は原則 **1.0 以下**。メンバーセルの直接編集では、ユーザーが明示的に選択した場合のみ1.0超過をそのまま保存できます。この制約はDBレベルではなくアプリケーション層（`src/router.ts`）で扱います。

### 配分ロジック

- **月次編集**: 月次表示では各月のキャパシティを個別に編集・保存します。
- **四半期編集**: 四半期表示で合計値を変更すると、既存の月別値がある場合は比率を保って3ヶ月へ配分し、空の場合は均等配分します。
- **合計更新時の比例再配分**: `allocations.updateTotal` で機能のキャパシティ合計を変更すると、対象月の既存メンバー配分が新旧比率でスケーリングされ、その後各メンバーの残月次キャパシティでキャップされます。割り当てきれない分は「未アサイン」として残ります。
- **個人配分の上限**: `allocations.previewMemberAllocation` で他Feature使用量と割り当て可能量を取得し、月次上限を超える場合はUIで解決方法を選択します。`allocations.updateMemberAllocation` は `capacityConflictResolution` に応じて、割り当て可能量まで丸める・1.0/月超過を許可する・他Featureを比例減少する、のいずれかを実行します。四半期表示では3ヶ月それぞれに同じルールを適用します。
- **四半期移動**: `allocations.moveQuarter` は配下3ヶ月のキャパシティ合計とメンバー配分を別四半期へ移動し、メンバーの月次キャップを尊重しながらマージします。割り当てきれない分は移動先Featureの未アサインとして残ります。
- **メンバーアサイン**: `allocations.assignMember` は指定メンバーを全月に capacity=0 で登録し、フィーチャー展開時に表示されるようにします。
- **メンバー除外**: `allocations.removeMemberFromFeature` は指定フィーチャーからメンバーの全月配分を削除し、`totalCapacity` を再計算します。

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
│ [-] Epic X  │  [3.0]   │  [2.5]   │          │     │ ← Epic見出し（配下合計）
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

ヘッダーには `Quarter` / `Month` の表示切替があります。初期表示は `Quarter` で、リロードすると初期表示へ戻ります。

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
| 詳細アイコン | ダイアログで名前・説明・複数リンクを編集 |
| `[+]` ボタン | メンバー行をインライン展開・折りたたみ |
| 🔴 赤点（overflow-dot） | いずれかの四半期に未アサイン分がある場合に表示 |

月次表示の合計値を変更すると、対象月の既存メンバー配分が**比率を保ったまま**自動スケーリングされます。四半期表示の合計値を変更すると、3ヶ月の既存比率を保って月次値へ反映し、空の場合は均等配分します。特定メンバーの月次配分が 1.0 を超える場合はそのメンバーを 1.0 で打ち止めにし、超過分は「未アサイン」行に分離します。

#### メンバー行（展開時）

Feature 行の `[+]` をクリックすると展開されます。表示されるのは**そのフィーチャーにアサインされたメンバーのみ**です。

| 要素 | 説明 |
|---|---|
| メンバーセル | 個人のキャパシティをヒートマップで表示。月次表示は0〜1、四半期表示は3ヶ月合計で編集 |
| 超過ハイライト | 月次 1.0 相当を超えるセルは赤背景で強調表示 |
| 未アサイン行 | `totalCapacity` - 担当者合計 > 0 の場合に赤イタリックで表示 |
| ホバー時 `×` ボタン | **このフィーチャーから**そのメンバーを削除（確認ダイアログあり）。全月の配分が除去され `totalCapacity` も更新される |
| `+ メンバーを割り当て` | クリックするとドロップダウンが開き、未アサインのメンバーをフィーチャー単位で追加できる。追加直後のキャパシティは 0 |

メンバーセルの値を直接変更した場合は、保存前に `allocations.previewMemberAllocation` が呼ばれます。同じメンバー・同じ月の合計が1.0を超える入力では、セル付近のポップオーバーに `現在の他Feature` と `割り当て可能` が表示され、次のいずれかを選びます。四半期表示で編集した場合は、3ヶ月の既存比率を保って月次値へ反映し、空の場合は均等配分します。

| 選択肢 | 挙動 |
|---|---|
| 割り当て可能量で割り当て | 他Featureへの配分済み分を差し引いた残余で保存 |
| 1を超えて割り当て | 入力値をそのまま保存し、月次合計1.0超過を許可 |
| 他Featureを比例減少 | 対象Featureは入力値で保存し、他Featureの同メンバー・同月配分を比例縮小して合計1.0にする |

入力値自体が表示単位の上限（月次は1.0、四半期は3.0）を超える場合は、確認なしで入力値をそのまま保存します。月次合計1.0を超えているメンバー・月はFeature画面とMember画面で警告色になります。

#### ツールバー

| ボタン | 挙動 |
|---|---|
| `+ Epic` | 新しいEpicを末尾に追加 |
| Epic内 `+ Feature` | 新しいフィーチャーを対象Epicの末尾に追加 |
| `+ Member` | 新しいメンバーを追加（名前はクリックでリネーム可） |
| `+ Quarter` | 直近クォーターの翌四半期と配下3ヶ月を追加 |

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

全 API プロシージャは `src/router.ts` 一ファイルに集約されています。`epics` / `features` / `members` / `quarters` / `allocations` / `export` / `import` のグループに分かれています。

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

サーバーが起動している状態で、機能・メンバーの管理をコマンドラインから行えます。CLI は `PORT` で指定されたローカルサーバーに接続します（未指定時は `http://localhost:3000`）。パッケージとして取得できる環境では `bunx roadmap-tool` で実行できます。

```sh
# 接続先ポート（デフォルト: 3000）
export PORT=3000

# features
bunx roadmap-tool features list
bunx roadmap-tool features add "認証機能" --epic-id <epic-id> --description "説明" --link "Spec=https://example.com/spec"
bunx roadmap-tool features rename <id> "認証機能 v2" --epic-id <epic-id> --description "説明" --link "Issue=https://example.com/issue"
bunx roadmap-tool features rename <id> "認証機能 v2" --clear-description --clear-links
bunx roadmap-tool features move <id> --epic-id <epic-id> --before <feature-id>
bunx roadmap-tool features import features.csv
cat features.csv | bunx roadmap-tool features import -

# epics
bunx roadmap-tool epics list
bunx roadmap-tool epics add "認証Epic" --description "説明" --link "Spec=https://example.com/spec"
bunx roadmap-tool epics rename <id> "認証Epic v2" --clear-description --clear-links
bunx roadmap-tool epics move <id> --before <epic-id>
bunx roadmap-tool epics delete <id>
bunx roadmap-tool epics import epics.csv

# members
bunx roadmap-tool members list
bunx roadmap-tool members add "Alice"
bunx roadmap-tool members rename <id> "Bob"
bunx roadmap-tool members import members.tsv --mode append
cat members.tsv | bunx roadmap-tool members import - --mode sync
```

Feature metadata CSV は `epic,name,description,links` の4列です。Epic metadata CSV は `name,description,links` の3列です。`links` は `[{"title":"Spec","url":"https://example.com/spec"}]` のJSON文字列で、import時は同名Feature/Epicの説明・リンクをCSV内容で置き換えます。Member TSV は `name` 必須、`id` または `member_id` と `max_capacity` は任意です。`--mode append` は追記・更新、`--mode sync` はTSVに載っていないMemberを削除して同期します。

Feature一覧のCLI出力はタブ区切りの ID・Epic ID・名前・説明・リンク件数です。Epic一覧のCLI出力はタブ区切りの ID・名前・説明・リンク件数・既定フラグです。Member一覧のCLI出力はタブ区切りの ID と名前です。

## Single Binary

```sh
bun run build:binary

./roadmap-tool                  # UIサーバーを起動してブラウザを開く
./roadmap-tool features list    # CLIとして起動中サーバーへ接続する

PORT=4000 ./roadmap-tool
PORT=4000 ./roadmap-tool members list
```

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
