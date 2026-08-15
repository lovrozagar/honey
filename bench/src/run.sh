#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$DIR/.."
BOMBARDIER="${BOMBARDIER:-/tmp/bombardier}"
DURATION="${BENCH_DURATION:-10s}"
CONNECTIONS="${BENCH_CONNECTIONS:-100}"
MODE="${BENCH_MODE:-prod}"

ENVS=()
MATRIX=""
FILTER=""
for arg in "$@"; do
	case "$arg" in
		bun | node) ENVS+=("$arg") ;;
		all) ENVS=(bun node) ;;
		naked | zod) MATRIX="$arg" ;;
		json | params | validate | middleware) FILTER="$arg" ;;
		both) MATRIX="both" ;;
		*)
			echo "unknown arg: $arg" >&2
			echo "usage: run.sh [bun|node|all] [naked|zod|both] [json|params|validate|middleware]" >&2
			exit 1
			;;
	esac
done
if [ ${#ENVS[@]} -eq 0 ]; then
	ENVS=(bun)
fi
if [ -z "$MATRIX" ]; then
	MATRIX="both"
fi

if [ ! -x "$BOMBARDIER" ]; then
	echo "bombardier not found at $BOMBARDIER"
	echo "Install: curl -fsSL -o /tmp/bombardier https://github.com/codesenberg/bombardier/releases/download/v1.2.6/bombardier-linux-amd64 && chmod +x /tmp/bombardier"
	exit 1
fi

FRAMEWORKS=("honey" "hono" "elysia" "express" "nest")
BUN_PORTS=("3100" "3101" "3102" "3103" "3104")
NODE_PORTS=("3300" "3301" "3302" "3303" "3304")
FW_PORTS=("${BUN_PORTS[@]}")
APP_PIDS=()

ports_for() {
	if [ "$1" = "node" ]; then
		echo "${NODE_PORTS[@]}"
	else
		echo "${BUN_PORTS[@]}"
	fi
}

port_busy() {
	ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
}

kill_port() {
	fuser -k "$1/tcp" >/dev/null 2>&1 || true
	lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null || true
}

cleanup() {
	for pid in "${APP_PIDS[@]}"; do
		kill -9 "$pid" >/dev/null 2>&1 || true
		pkill -9 -P "$pid" >/dev/null 2>&1 || true
	done
	APP_PIDS=()
	for port in "${FW_PORTS[@]}"; do
		kill_port "$port"
	done
	for port in "${FW_PORTS[@]}"; do
		for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
			if ! port_busy "$port"; then
				break
			fi
			kill_port "$port"
			sleep 0.2
		done
		if port_busy "$port"; then
			echo "warn: port $port still listed as listening after cleanup" >&2
		fi
	done
}
trap cleanup EXIT

start_app() {
	local env="$1"
	local matrix="$2"
	local fw="$3"
	local port="$4"
	local dist="$ROOT/dist/$env/$matrix"
	local src="$DIR/apps/$env/$matrix/$fw.ts"

	if [ "$fw" = "nest" ]; then
		echo "  Starting $fw ($env / $matrix, TS) on :$port..."
		if [ "$env" = "node" ]; then
			PORT="$port" bunx tsx "$src" &
		else
			PORT="$port" bun run "$src" &
		fi
		APP_PIDS+=($!)
		return
	fi

	if [ "$MODE" = "prod" ]; then
		echo "  Starting $fw ($env / $matrix, built) on :$port..."
		if [ "$env" = "node" ]; then
			PORT="$port" node "$dist/$fw/index.js" &
		else
			PORT="$port" bun "$dist/$fw/index.js" &
		fi
		APP_PIDS+=($!)
		return
	fi

	echo "  Starting $fw ($env / $matrix, dev) on :$port..."
	if [ "$env" = "node" ]; then
		PORT="$port" bunx tsx "$src" &
	else
		PORT="$port" bun run "$src" &
	fi
	APP_PIDS+=($!)
}

run_matrix() {
	local env="$1"
	local matrix="$2"
	local dist="$ROOT/dist/$env/$matrix"
	# shellcheck disable=SC2207
	FW_PORTS=($(ports_for "$env"))

	cleanup
	sleep 1

	if [ "$MODE" = "prod" ]; then
		for fw in "${FRAMEWORKS[@]}"; do
			if [ "$fw" = "nest" ]; then
				continue
			fi
			if [ ! -f "$dist/$fw/index.js" ]; then
				echo "Built output missing for $env/$matrix/$fw. Run: bash src/build.sh $env $matrix"
				exit 1
			fi
		done
	fi

	echo ""
	echo "╔══════════════════════════════════════════════════════════╗"
	echo "║  Honey vs Hono vs Elysia vs Express vs Nest — $env ($matrix)"
	echo "║  ${DURATION}, ${CONNECTIONS}c, mode: ${MODE}"
	echo "╚══════════════════════════════════════════════════════════╝"
	echo ""

	if [ "$MODE" = "prod" ]; then
		echo "  Bundle sizes:"
		for fw in "${FRAMEWORKS[@]}"; do
			file="$dist/$fw/index.js"
			if [ ! -f "$file" ]; then
				printf "    %-10s %s\n" "$fw" "n/a (TS, not a bun bundle)"
				continue
			fi
			raw=$(wc -c < "$file")
			gz=$(gzip -c "$file" | wc -c)
			raw_kb=$(LC_NUMERIC=C awk "BEGIN { printf \"%.1f\", $raw/1024 }")
			gz_kb=$(LC_NUMERIC=C awk "BEGIN { printf \"%.1f\", $gz/1024 }")
			printf "    %-10s %6s KB (gzip: %5s KB)\n" "$fw" "$raw_kb" "$gz_kb"
		done
		echo ""
	fi

	for i in "${!FRAMEWORKS[@]}"; do
		start_app "$env" "$matrix" "${FRAMEWORKS[$i]}" "${FW_PORTS[$i]}"
	done
	for port in "${FW_PORTS[@]}"; do
		ok=0
		for _ in $(seq 1 40); do
			if curl -fsS -m 1 -o /dev/null "http://127.0.0.1:${port}/json"; then
				ok=1
				break
			fi
			sleep 0.15
		done
		if [ "$ok" -ne 1 ]; then
			echo "server on :$port did not become ready" >&2
			exit 1
		fi
	done

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

for env in "${ENVS[@]}"; do
	if [ "$MATRIX" = "both" ]; then
		run_matrix "$env" naked
		run_matrix "$env" zod
	else
		run_matrix "$env" "$MATRIX"
	fi
done

echo "Done."
