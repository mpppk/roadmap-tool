# CLAUDE.md

このファイルは、リポジトリ内のコードを操作する際に Claude Code（claude.ai/code）へのガイダンスを提供します。

Node.js の代わりに Bun を使用してください。

- `node <file>` や `ts-node <file>` の代わりに `bun <file>` を使用する
- `jest` や `vitest` の代わりに `bun test` を使用する
- `webpack` や `esbuild` の代わりに `bun build <file.html|file.ts|file.css>` を使用する
- `npm install` や `yarn install`、`pnpm install` の代わりに `bun install` を使用する
- `npm run <script>` や `yarn run <script>`、`pnpm run <script>` の代わりに `bun run <script>` を使用する
- `npx <package> <command>` の代わりに `bunx <package> <command>` を使用する
- Bun は `.env` を自動的に読み込むため、dotenv は使用しない

## APIs

- `Bun.serve()` は WebSocket、HTTPS、ルーティングをサポートする。`express` は使用しない。
- SQLite には `bun:sqlite` を使用する。`better-sqlite3` は使用しない。
- Redis には `Bun.redis` を使用する。`ioredis` は使用しない。
- Postgres には `Bun.sql` を使用する。`pg` や `postgres.js` は使用しない。
- `WebSocket` は組み込み済み。`ws` は使用しない。
- `node:fs` の readFile/writeFile より `Bun.file` を優先する
- execa の代わりに `Bun.$\`ls\`` を使用する

## 開発コマンド

```sh
bun dev              # HMR 付き開発サーバーを起動
bun run typecheck    # TypeScript 型チェック（emit なし）
bun run lint         # Biome で src/ をリント
bun run check        # Biome リント + フォーマットチェック
bun run format       # Biome で src/ をフォーマット（書き込み）
bun test             # 全テストを実行
bun test src/db/schema.test.ts  # 単一テストファイルを実行
bun run build        # build.ts による本番ビルド
```

データベース管理（Drizzle Kit を使用）:

```sh
bun run db:seed      # 開発用サンプルデータを db.sqlite に投入（冪等）
bun run db:generate  # スキーマ変更からマイグレーションを生成
bun run db:migrate   # 未適用のマイグレーションを実行
bun run db:push      # スキーマを直接プッシュ（開発環境のみ）
bun run db:studio    # Drizzle Studio UI を起動
```

CI では `typecheck` → `lint` → `format:check` → `test` → `build` の順に実行されます。マージ前にすべて通過する必要があります。

## アーキテクチャ

これは**チームのリソース配分 / ロードマップ計画ツール**です。

2つの軸があります:

1. **戦略ツリー** — Vision → Strategic Intent → Initiative → Epic の階層で戦略を整理します（`StrategyTreeView`）。Epic が実際の作業項目（旧 "feature"）です。
2. **キャパシティ計画** — チームメンバーとクォーターを作成し、各メンバーの月次キャパシティ（0〜1）を Epic に割り当てます。クォータービューでは、クォーター内の3ヶ月分のレコードを集計します。

主要なトップレベルビュー（`src/App.tsx` が `window.location.pathname` でルーティング）:

- `CapacityView`（`/`） — Epic × クォーター/メンバーのキャパシティ割り当てヒートマップ
- `StrategyTreeView`（`/strategy`） — Vision → Strategic Intent → Initiative → Epic の階層編集
- `MembersView`（`/members`） — メンバー管理と月次キャパシティ確認

全ビューに undo/redo（history）機能が組み込まれています（後述）。

### スタック

- **ランタイム**: `Bun.serve()` を使用した Bun — Express、Vite は不使用
- **フロントエンド**: React 19 SPA。`src/index.html` → `src/frontend.tsx` からマウント
- **スタイリング**: `bun-plugin-tailwind` 経由の Tailwind CSS 4。UI コンポーネントは shadcn/ui（`src/components/ui/`）
- **API レイヤー**: HTTP 経由でエンドツーエンドの型安全 RPC を提供する [oRPC](https://orpc.unnoq.com/)（`/orpc/*`）
- **データベース**: `bun:sqlite` + Drizzle ORM による SQLite。スキーマは `src/db/schema.ts`
- **バリデーション**: Zod 4

### リクエストフロー

```
Browser → React (src/App.tsx)
       → orpc client (src/orpc-client.ts) → POST /orpc/<procedure>
       → Bun.serve (src/server.ts) → RPCHandler
        → router procedure (src/router.ts) — Zod バリデーション済み入力
        → Drizzle ORM → SQLite (ローカルファイル)
```

エントリポイントは `src/index.ts`（3行のみ）で、`src/server.ts` の `startServer()` を呼ぶだけです。実体の `Bun.serve()` セットアップ・`RPCHandler`・フロントエンド配信は `src/server.ts` にあります。`src/server.ts` は `/events/data-changes` の **SSE エンドポイント**も提供し、データ変更を伴う RPC（mutating procedure）の実行後に接続中の全クライアントへ通知します。これにより複数クライアント間でデータの更新を検知できます。

すべての API プロシージャは `src/router.ts` の単一ファイルに集約されています。プロシージャは `history`、`visions`、`strategicIntents`、`initiatives`、`epics`、`members`、`quarters`、`allocations`、`export`、`import` にグループ化されています。エクスポートされた `AppRouter` 型はクライアントが完全な型推論のためにインポートします。

### データベーススキーマ

11テーブル。すべて整数 PK を持ちます。外部キーの ON DELETE 挙動はテーブルごとに異なる（CASCADE / SET NULL / RESTRICT）ので注意してください。

戦略ツリー（Vision → Strategic Intent → Initiative → Epic）:

- `visions` — 最上位。名前はトリム済みでユニーク
- `strategic_intents` — `visionId` → `visions`（**ON DELETE CASCADE**）。名前はユニーク
- `initiatives` — `strategicIntentId` → `strategic_intents`（**ON DELETE SET NULL**、戦略未紐付けも可）。`isDefault` が1つだけ存在しうる（Epic 作成時のデフォルト所属先）
- `initiative_links` — `initiativeId` → `initiatives`（**ON DELETE CASCADE**）。Initiative の参考リンク（title/url/position）
- `epics` — 作業項目（旧 "feature"）。`initiativeId` → `initiatives`（**ON DELETE RESTRICT**、Epic を持つ Initiative は削除不可）。名前はユニーク
- `epic_links` — `epicId` → `epics`（**ON DELETE CASCADE**）。Epic の参考リンク

キャパシティ計画:

- `members` — チームメンバー（名前はユニーク）。`maxCapacity`（NULL または `0 < x <= 1`）で個人の上限を設定可能
- `quarters` — クォーターグループ: `(year, quarter 1-4)` のユニークペア
- `months` — 計画期間: `(year, month 1-12)` のユニークペア。`quarterId` → `quarters`（**ON DELETE CASCADE**）
- `epic_months` — Epic の月次予算キャパシティ（`totalCapacity`）。`epicId`/`monthId` ともに **ON DELETE CASCADE**
- `member_month_allocations` — Epic の月次に割り当てられた個々のメンバーキャパシティ（`capacity`、0〜1）。`epicId`/`monthId`/`memberId` ともに **ON DELETE CASCADE**

**キャパシティの単位**: キャパシティは月次で保存（0 = アイドル、1 = フル）。クォーター表示ではクォーター内の3ヶ月を集計します。

**主要な制約**: 1ヶ月内のすべての Epic にわたるメンバーの合計 `capacity` は、そのメンバーの `maxCapacity`（未設定時は `1.0`）を超えることはできません。また各 `(epicId, monthId)` で `epic_months.totalCapacity >= SUM(member_month_allocations.capacity)` が保たれます。これらは DB レベルではなく `router.ts` の `allocations.*` プロシージャで強制されます。

### 割り当てビジネスロジック

`allocations.updateTotal` — Epic 月次の合計キャパシティが変更された場合、既存のメンバー割り当ては**比例再配分**（`newTotal / oldTotal` でスケール）され、その後それぞれのメンバーの残余月次キャパシティで個別に上限が設定されます。クォーター編集では、要求された合計を３ヶ月に分割し、既存の月次比率を維持するか、空のクォーターは均等配分します。

`allocations.updateMemberAllocation` — 要求された値をそのメンバー×月に設定します。キャパシティの衝突（メンバー上限超過）は `capacityConflictResolution` で解決方法を選べます:

- `fitWithinLimit`（デフォルト） — `maxCapacity - usedElsewhere` で暗黙的に上限設定
- `allowOverflow` — 上限を超えてもそのまま許可
- `rebalanceOthersProportionally` — 他 Epic の割り当てを比例縮小して収める
- `rebalanceAllProportionally` — 自分を含む全 Epic を比例縮小

`allocations.previewMemberAllocation` で、実際に更新せず結果をプレビューできます。

`allocations.moveQuarter` — Epic 月次データ（合計 + メンバー割り当て）をあるクォーターから別のクォーターへ月ごとにマージします。メンバーの月次上限を考慮します。

`allocations.assignMember` / `removeMemberFromEpic` — Epic に対するメンバーの割り当て行（0キャパシティのプレースホルダ）を一括追加 / 削除します。

### history（undo/redo）

`history.snapshot` でロードマップ全体（initiatives / epics / members / quarters / allocations）のスナップショットを取得し、`history.restore` で楽観的ロック（期待スナップショットとの不一致を検出）付きで復元します。フロントエンドは `src/history-client.ts` の `HistoryController` と `src/App.tsx` で undo/redo スタック（上限100）を管理し、Ctrl/Cmd+Z（undo）・Ctrl/Cmd+Shift+Z または Ctrl/Cmd+Y（redo）に対応します。他クライアントによる外部データ変更を SSE 経由で検知すると履歴は自動クリアされます。

### import / export

`export.*` は Epic/メンバー/割り当ての CSV・TSV、および Epic/Initiative のメタデータ CSV を出力します。`import.*` は `csvImport` / `tsvImport`（割り当ての**加算的アップサート**）、`epicMetadataCSVImport`、`initiativeMetadataCSVImport`、`memberTSVImport`（`append` / `sync` モード）を提供します。import は不足する quarter/month/epic/member を自動作成し、最後に `epic_months` の合計を再計算します。

### パスエイリアス

`@/*` は `src/*` に解決されます（`tsconfig.json` で設定済み。コードベース全体で使用）。

### CLI

`src/cli.ts` は、`epics` / `initiatives` / `members` の3リソースを操作する薄い oRPC クライアント CLI を提供します。`PORT`（デフォルト: `3000`）から `http://localhost:<PORT>` に接続し、サーバーの起動が必要です。

- `epics` — `list` / `add` / `rename` / `move` / `delete` / `import`
- `initiatives` — `list` / `add` / `rename` / `move` / `delete` / `import`
- `members` — `list` / `add` / `rename` / `delete` / `import`（`--mode append|sync`） / `capacity --year <y> --month <m>`
- グローバル: `update`（`--check` で確認のみ） / `-v` / `--version`

`import` 系はファイルパスまたは `-`（標準入力）から CSV/TSV を読み込みます。

### テスト

テストには `bun:test` を使用します。テストファイルは6つあります:

- `src/router.test.ts` — oRPC ルーターの中核ロジック（epics / initiatives / members / allocations / import）。最大のテスト
- `src/server.test.ts` — `orpcProcedureNameFromPathname` / `shouldNotifyDataChange`（SSE 通知判定）
- `src/capacity-clipboard.test.ts` — `parseCapacityTSV`（クリップボード貼り付け用 TSV パース、小数カンマ対応）
- `src/db/schema.test.ts` — Drizzle スキーマと制約（インメモリ SQLite）
- `src/db/migrate.test.ts` — マイグレーション（旧 `features` → `epics` への移行を含む）
- `src/db/path.test.ts` — `resolveDbPath`（`ROADMAP_DB` / `XDG_DATA_HOME` / `HOME` の解決）

### フロントエンド

`Bun.serve()` で HTML インポートを使用します。`vite` は使用しません。HTML インポートは React、CSS、Tailwind を完全サポートしています。

`src/index.html` は `src/server.ts` にルートハンドラーとして直接インポートされます — Bun のバンドラーが `src/frontend.tsx` と CSS を自動的にトランスパイル・バンドルします。開発環境では `import.meta.hot` を通じて HMR が有効です。

詳細については、`node_modules/bun-types/docs/**.mdx` にある Bun API ドキュメントを参照してください。

## 実装プランの作成

プランの作成時は、検討が必要な項目を徹底的に洗い出し、曖昧性が完全に排除されるまでユーザに質問・確認を行なってください。

## ブラウザでの動作確認

`bun dev` で開発サーバーを起動し、発行されたURL（例: `https://some-branch-name.roadmap-tool.localhost`）にブラウザでアクセスしてください

## PRの作成

* PRには実装プランの内容をdetailsタグで記載してください。
* PRにはTest Planを記載してください。Test Planには、手動での動作確認の手順を記載してください。その後、実際にブラウザで動作確認を行なってください。
* ブラウザでの動作確認中はスクリーンショットを適宜撮影し、Gyazo CLI経由でアップロードしてください。
* 動作確認の完了後は、結果をPRのdescriptionに追記してください。結果には撮影したスクリーンショットのGyazo画像を記載してください。



結果には可能な限りスクリーンショットやGIFを添付してください。
