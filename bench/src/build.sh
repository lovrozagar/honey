#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$DIR/.."

ENVS=()
MATRICES=()
for arg in "$@"; do
	case "$arg" in
		bun | node) ENVS+=("$arg") ;;
		all) ENVS=(bun node) ;;
		naked | zod) MATRICES+=("$arg") ;;
		both) MATRICES=(naked zod) ;;
		*)
			echo "unknown arg: $arg" >&2
			echo "usage: build.sh [bun|node|all] [naked|zod|both]" >&2
			exit 1
			;;
	esac
done
if [ ${#ENVS[@]} -eq 0 ]; then
	ENVS=(bun)
fi
if [ ${#MATRICES[@]} -eq 0 ]; then
	MATRICES=(naked zod)
fi

FRAMEWORKS=(honey hono elysia express nest)

build_one() {
	local env="$1"
	local matrix="$2"
	local dist="$ROOT/dist/$env/$matrix"
	local target
	if [ "$env" = "node" ]; then
		target=node
	else
		target=bun
	fi

	rm -rf "$dist"
	mkdir -p "$dist"
	echo "━━ $env / $matrix  (bun build --minify --target $target) ━━"

	for fw in "${FRAMEWORKS[@]}"; do
		src="$DIR/apps/$env/$matrix/$fw.ts"
		if [ ! -f "$src" ]; then
			echo "missing $src" >&2
			exit 1
		fi
		echo "▸ $fw"
		if [ "$fw" = "nest" ]; then
			echo "  skipped (Nest decorator metadata does not survive bun bundle)"
			continue
		fi
		bun build "$src" \
			--outfile "$dist/$fw/index.js" \
			--minify \
			--target "$target" \
			2>&1 | grep -v "^$"
		echo ""
	done

	echo "Bundle sizes ($env / $matrix):"
	printf "  %-10s %10s %12s\n" "Framework" "Raw" "Gzip"
	echo "  ─────────────────────────────────────────────"
	for fw in "${FRAMEWORKS[@]}"; do
		file="$dist/$fw/index.js"
		if [ ! -f "$file" ]; then
			printf "  %-10s %8s %8s\n" "$fw" "n/a" "n/a"
			continue
		fi
		raw=$(wc -c < "$file")
		gz=$(gzip -c "$file" | wc -c)
		raw_kb=$(LC_NUMERIC=C awk "BEGIN { printf \"%.1f\", $raw/1024 }")
		gz_kb=$(LC_NUMERIC=C awk "BEGIN { printf \"%.1f\", $gz/1024 }")
		printf "  %-10s %8s KB %8s KB\n" "$fw" "$raw_kb" "$gz_kb"
	done
	echo ""
}

echo "Building bench apps"
echo ""
for env in "${ENVS[@]}"; do
	for matrix in "${MATRICES[@]}"; do
		build_one "$env" "$matrix"
	done
done
