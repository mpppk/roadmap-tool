---
name: roadmap-cli
description: Use the roadmap-tool CLI to list, add, or rename roadmap features and members. Use when managing roadmap-tool data from Claude Code.
---

# roadmap-tool CLI

Before using the CLI, run `bun src/cli.ts help` and follow that output as the source of truth.

The CLI connects to `ROADMAP_URL`, defaulting to `http://localhost:3000`, so ensure the roadmap-tool server is running before commands that call the API.

Use read-only list commands freely when relevant. Run mutating commands such as add or rename only when the user explicitly asks to change roadmap data.
