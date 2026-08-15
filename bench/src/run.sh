#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$DIR/.."
BOMBARDIER="${BOMBARDIER:-/tmp/bombardier}"
DURATION="${BENCH_DURATION:-10s}"
CONNECTIONS="${BENCH_CONNECTIONS:-100}"
MODE="${BENCH_MODE:-prod}"

MATRIX="${BENCH_MATRIX:-}"
FILTER=""
for arg in "$@"; do
  case "$arg" in
    naked|zod) MATRIX="$arg" ;;
    json|params|validate|middleware) FILTER="$arg" ;;
    both) MATRIX="both" ;;
    *)
      echo "unknown arg: $arg" >&2
      echo "usage: run.sh [naked|zod|both] [json|params|validate|middleware]" >&2
      exit 1
      ;;
  esac
done
if [ -z "$MATRIX" ]; then
  MATRIX="both"
fi

if [ ! -x "$BOMBARDIER" ]; then
  echo "bombardier not found at $BOMBARDIER"
  echo "Install: curl -fsSL -o /tmp/bombardier https://github.com/codesenberg/bombardier/releases/download/v1.2.6/bombardier-linux-amd64 && chmod +x /tmp/bombardier"
  exit 1
fi

FRAMEWORKS=("honey" "hono" "elysia")
FW_PORTS=("3100" "3101" "3102")

cleanup() {
  for port in "${FW_PORTS[@]}"; do
    lsof -ti:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  done
}
trap cleanup EXIT

run_matrix() {
  local matrix="$1"
  local dist="$ROOT/dist/$matrix"

  cleanup
  sleep 1

  if [ "$MODE" = "prod" ]; then
    for fw in "${FRAMEWORKS[@]}"; do
      if [ ! -f "$dist/$fw/index.js" ]; then
        echo "Built output missing for $matrix/$fw. Run: bash src/build.sh $matrix"
        exit 1
      fi
    done
  fi

  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  Honey vs Hono vs Elysia — Bun  ($matrix)                 ║"
  echo "║  ${DURATION}, ${CONNECTIONS}c, mode: ${MODE}                             ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""

  if [ "$MODE" = "prod" ]; then
    echo "  Bundle sizes:"
    for fw in "${FRAMEWORKS[@]}"; do
      file="$dist/$fw/index.js"
      raw=$(wc -c < "$file")
      gz=$(gzip -c "$file" | wc -c)
      raw_kb=$(LC_NUMERIC=C awk "BEGIN { printf \"%.1f\", $raw/1024 }")
      gz_kb=$(LC_NUMERIC=C awk "BEGIN { printf \"%.1f\", $gz/1024 }")
      printf "    %-10s %6s KB (gzip: %5s KB)\n" "$fw" "$raw_kb" "$gz_kb"
    done
    echo ""
  fi

  for i in "${!FRAMEWORKS[@]}"; do
    fw="${FRAMEWORKS[$i]}"
    port="${FW_PORTS[$i]}"

    if [ "$MODE" = "prod" ]; then
      echo "  Starting $fw ($matrix, built) on :$port..."
      PORT="$port" bun "$dist/$fw/index.js" &
    else
      echo "  Starting $fw ($matrix, dev) on :$port..."
      PORT="$port" bun run "$DIR/apps/$matrix/$fw.ts" &
    fi
  done
  sleep 2

  echo ""

  run_scenario() {
    local name="$1" method="$2" path="$3" body="$4"

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  $name ($method $path)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    for i in "${!FRAMEWORKS[@]}"; do
      local fw="${FRAMEWORKS[$i]}"
      local port="${FW_PORTS[$i]}"
      local url="http://localhost:$port$path"

      local args=(-c "$CONNECTIONS" -d "$DURATION" -m "$method" --print result)
      if [ "$method" = "POST" ] && [ -n "$body" ]; then
        args+=(-H "Content-Type: application/json" -b "$body")
      fi

      echo ""
      echo "  ▸ $fw"
      $BOMBARDIER "${args[@]}" "$url" 2>&1 | while IFS= read -r line; do echo "    $line"; done
    done
    echo ""
  }

  if [ -z "$FILTER" ] || [ "$FILTER" = "json" ]; then
    run_scenario "Plain JSON" "GET" "/json" ""
  fi

  if [ -z "$FILTER" ] || [ "$FILTER" = "params" ]; then
    run_scenario "Path Params" "GET" "/params/42" ""
  fi

  if [ "$matrix" = "zod" ] && { [ -z "$FILTER" ] || [ "$FILTER" = "validate" ]; }; then
    run_scenario "Zod Validation" "POST" "/validate" '{"name":"test","age":25}'
  fi

  if [ -z "$FILTER" ] || [ "$FILTER" = "middleware" ]; then
    run_scenario "Middleware Chain" "GET" "/middleware" ""
  fi

  cleanup
  sleep 1
}

if [ "$MATRIX" = "both" ]; then
  run_matrix naked
  run_matrix zod
else
  run_matrix "$MATRIX"
fi

echo "Done."
