#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$DIR/../dist"
rm -rf "$DIST"
mkdir -p "$DIST"

echo "Building all frameworks with bun build --minify --target bun"
echo "(same bundler for fair comparison)"
echo ""

for fw in honey hono elysia; do
  echo "▸ $fw"
  bun build "$DIR/apps/$fw.ts" \
    --outfile "$DIST/$fw/index.js" \
    --minify \
    --target bun \
    2>&1 | grep -v "^$"
  echo ""
done

echo "Bundle sizes:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "  %-10s %10s %12s\n" "Framework" "Raw" "Gzip"
echo "  ─────────────────────────────────────────────"
for fw in honey hono elysia; do
  file="$DIST/$fw/index.js"
  if [ -f "$file" ]; then
    raw=$(wc -c < "$file")
    gz=$(gzip -c "$file" | wc -c)
    raw_kb=$(LC_NUMERIC=C awk "BEGIN { printf \"%.1f\", $raw/1024 }")
    gz_kb=$(LC_NUMERIC=C awk "BEGIN { printf \"%.1f\", $gz/1024 }")
    printf "  %-10s %8s KB %8s KB\n" "$fw" "$raw_kb" "$gz_kb"
  fi
done
echo ""
