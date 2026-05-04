#!/usr/bin/env bash
set -euo pipefail

INPUT="$(cat)"

if [ "$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ]; then
  exit 0
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if bun run typecheck >"$TMP" 2>&1 &&
  bun run lint >>"$TMP" 2>&1 &&
  bun run format:check >>"$TMP" 2>&1; then
  exit 0
fi

OUT="$(tail -n 120 "$TMP")"

jq -nc --arg reason "CI checks failed. Fix the errors below, then stop.

$OUT" '{decision:"block", reason:$reason}'
