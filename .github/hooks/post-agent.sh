#!/bin/bash
# Post-agent hook: runs TypeScript type check, linter, and formatter after each agent turn.
# If type check or lint fails, blocks the agent and requests fixes.

FAILED=false
REASON=""

echo "🔍 Running TypeScript type check..." >&2
TYPECHECK_OUT=$(./node_modules/.bin/tsc --noEmit 2>&1)
TYPECHECK_STATUS=$?
if [ $TYPECHECK_STATUS -ne 0 ]; then
  FAILED=true
  REASON+="TypeScript type check failed:\n${TYPECHECK_OUT}\n\n"
fi

echo "🔍 Running Biome lint..." >&2
LINT_OUT=$(bun run lint 2>&1)
LINT_STATUS=$?
if [ $LINT_STATUS -ne 0 ]; then
  FAILED=true
  REASON+="Biome lint failed:\n${LINT_OUT}\n\n"
fi

echo "🎨 Running Biome formatter..." >&2
bun run format >&2 2>&1

if [ "$FAILED" = true ]; then
  printf '%s' "$REASON" | jq -Rs '{"decision":"block","reason":.}'
else
  echo "✅ All checks passed!" >&2
fi
