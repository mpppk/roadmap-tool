#!/usr/bin/env bash
set -euo pipefail

if [ -n "${CLAUDE_CODE_REMOTE:-}" ]; then
  bun install
fi
