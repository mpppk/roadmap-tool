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
bun run db:seed      # 開発用サンプルデータを投入（サーバー起動不要・冪等）
bun run db:generate  # スキーマ変更からマイグレーションを生成
bun run db:migrate   # 未適用のマイグレーションを実行
bun run db:push      # スキーマを直接プッシュ（開発環境のみ）
bun run db:studio    # Drizzle Studio UI を起動
```

CI では `typecheck` → `lint` → `format:check` → `build` の順に実行されます。マージ前にすべて通過する必要があります。

## アーキテクチャ

これは**チームのリソース配分 / ロードマップ計画ツール**です。ユーザーはフィーチャー（作業項目）、チームメンバー、クォーターを作成し、各メンバーの月次キャパシティ（0、1）をフィーチャーに割り当てます。クォータービューでは、クォーター内の3ヶ月分のレコードを集計します。

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
       → Bun.serve (src/index.ts) → RPCHandler
        → router procedure (src/router.ts) — Zod バリデーション済み入力
        → Drizzle ORM → SQLite (ローカルファイル)
```

すべての API プロシージャは `src/router.ts` の単一ファイルに集約されています。プロシージャは `features`、`members`、`quarters`、`allocations`、`export` にグループ化されています。エクスポートされた `AppRouter` 型はクライアントが完全な型推論のためにインポートします。

### データベーススキーマ

5つのテーブル。すべて整数 PK と ON DELETE CASCADE の外部キーを持ちます:

- `features` — 作業項目（名前はユニーク）
- `members` — チームメンバー（名前はユニーク）
- `quarters` — クォーターグループ: `(year, quarter 1-4)` のユニークペア
- `months` — 計画期間: `(year, month 1-12)` のユニークペア。クォーターに紐付く
- `feature_months` — フィーチャーの月次予算キャパシティ（`totalCapacity`）
- `member_month_allocations` — フィーチャーの月次に割り当てられた個々のメンバーキャパシティ（`capacity`、0、1）

**キャパシティの単位**: キャパシティは月次で保存（0 = アイドル、1 = フル）。クォーター表示ではクォーター内の3ヶ月を集計します。

**主要な制約**: 1ヶ月内のすべてのフィーチャーにわたるメンバーの合計 `capacity` は `1.0` を超えることはできません。これは DB レベルではなく `router.ts` の `allocations.*` プロシージャで強制されます。

### 割り当てビジネスロジック

`allocations.updateTotal` — フィーチャー月次の合計キャパシティが変更された場合、既存のメンバー割り当ては**比例再配分**（`newTotal / oldTotal` でスケール）され、その後それぞれのメンバーの残余月次キャパシティで個別に上限が設定されます。クォーター編集では、要求された合計を３ヶ月に分割し、既存の月次比率を維持するか、空のクォーターは均等配分します。

`allocations.updateMemberAllocation` — 要求された値をそのメンバー×月に対して `1.0 - usedElsewhere` で暗黙的に上限設定します。

`allocations.moveQuarter` — フィーチャー月次データ（合計 + メンバー割り当て）をあるクォーターから別のクォーターへ月ごとにマージします。メンバーの月次上限を考慮します。

### パスエイリアス

`@/*` は `src/*` に解決されます（`tsconfig.json` で設定済み。コードベース全体で使用）。

### CLI

`src/cli.ts` は、フィーチャーとメンバー向けの薄い oRPC クライアント CLI を提供します。`PORT`（デフォルト: `3000`）から `http://localhost:<PORT>` に接続し、サーバーの起動が必要です。

### テスト

テストには `bun:test` を使用します。テストファイルは `src/db/schema.test.ts` のみで、Drizzle を介してインメモリ SQLite データベースを起動し、スキーマ制約を検証します。

### フロントエンド

`Bun.serve()` で HTML インポートを使用します。`vite` は使用しません。HTML インポートは React、CSS、Tailwind を完全サポートしています。

`src/index.html` は `src/index.ts` にルートハンドラーとして直接インポートされます — Bun のバンドラーが `src/frontend.tsx` と CSS を自動的にトランスパイル・バンドルします。開発環境では `import.meta.hot` を通じて HMR が有効です。

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
