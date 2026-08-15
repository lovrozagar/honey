#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$DIR/.."

if [ $# -eq 0 ] || [ "$1" = "both" ]; then
  MATRICES=(naked zod)
else
  MATRICES=("$@")
fi

echo "Building with bun build --minify --target bun"
echo "(same bundler for fair comparison)"
echo ""

for matrix in "${MATRICES[@]}"; do
  DIST="$ROOT/dist/$matrix"
  rm -rf "$DIST"
  mkdir -p "$DIST"
  echo "━━ $matrix ━━"
  for fw in honey hono elysia; do
    src="$DIR/apps/$matrix/$fw.ts"
    if [ ! -f "$src" ]; then
      echo "missing $src" >&2
      exit 1
    fi
    echo "▸ $fw"
    bun build "$src" \
      --outfile "$DIST/$fw/index.js" \
      --minify \
      --target bun \
      2>&1 | grep -v "^$"
    echo ""
  done

  echo "Bundle sizes ($matrix):"
  printf "  %-10s %10s %12s\n" "Framework" "Raw" "Gzip"
  echo "  ─────────────────────────────────────────────"
  for fw in honey hono elysia; do
    file="$DIST/$fw/index.js"
    raw=$(wc -c < "$file")
    gz=$(gzip -c "$file" | wc -c)
    raw_kb=$(LC_NUMERIC=C awk "BEGIN { printf \"%.1f\", $raw/1024 }")
    gz_kb=$(LC_NUMERIC=C awk "BEGIN { printf \"%.1f\", $gz/1024 }")
    printf "  %-10s %8s KB %8s KB\n" "$fw" "$raw_kb" "$gz_kb"
  done
  echo ""
done
