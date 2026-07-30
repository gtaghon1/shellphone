#!/usr/bin/env bash
# Build the Claude Desktop extension (.mcpb).
#
# Packs from a clean staging directory rather than the working tree, so the
# bundle can never pick up dev dependencies, test fixtures, local .shellphone
# state, or a stale dist/. What ships is exactly what is copied in here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$ROOT/build/mcpb"
VERSION="$(node -p "require('$ROOT/package.json').version")"
OUT="$ROOT/build/shellphone-$VERSION.mcpb"

echo "==> building TypeScript"
npm --prefix "$ROOT" run build --silent

echo "==> staging"
rm -rf "$ROOT/build"
mkdir -p "$STAGE"
cp -R "$ROOT/dist" "$STAGE/dist"
cp "$ROOT/manifest.json" "$ROOT/icon.png" "$ROOT/package.json" \
   "$ROOT/package-lock.json" "$ROOT/README.md" "$ROOT/PRIVACY.md" \
   "$ROOT/LICENSE" "$STAGE/"

echo "==> installing production dependencies"
# --ignore-scripts matters: package.json has a `prepare` hook that runs tsc,
# which is a dev dependency and is deliberately absent here.
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)
rm -f "$STAGE/package-lock.json"

echo "==> packing"
npx --yes @anthropic-ai/mcpb@2 pack "$STAGE" "$OUT"

echo
echo "built $OUT"
du -h "$OUT" | cut -f1 | sed 's/^/size: /'
