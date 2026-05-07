---
name: roadmap-cli
description: Use the roadmap-tool CLI to list, add, or rename roadmap features and members. Use when managing roadmap-tool data.
---

# roadmap-tool CLI

## Installation



CLI を使用する前に `bun src/cli.ts help` を実行し、その出力を信頼できる情報源として従ってください。

CLI は `ROADMAP_URL`（デフォルト: `http://localhost:3000`）に接続します。API を呼び出すコマンドを実行する前に、roadmap-tool サーバーが起動していることを確認してください。

関連する場合は読み取り専用の一覧表示コマンドを自由に使用してください。追加や名前変更などの変更コマンドは、ユーザーがロードマップデータの変更を明示的に要求した場合にのみ実行してください。
