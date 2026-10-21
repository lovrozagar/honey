#!/bin/bash
# The bench's process ownership, sourced by run.sh. An app starts as the leader of its own process group (setsid),
# recorded in APP_PIDS as "pid:start" with its start time (/proc/<pid>/stat field 22). stop_owned signals a group only
# while its leader's pid still names the process it started: once that process is gone the kernel may give the pid,
# and so the group id, to anyone else, and a recorded pid alone says nothing about whose process it now is. Nothing
# is signalled by port or as a stored pid's child.

APP_PIDS=()

# The start time of process $1, in clock ticks since boot; empty when there is no such process.
start_of() {
	local stat
	stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 0
	# the fields after the command, which may hold spaces and parentheses, start after its last ") "
	stat="${stat##*) }"
	# shellcheck disable=SC2086
	set -- $stat
	echo "${20}"
}

# The process group of process $1; empty when there is no such process.
group_of() {
	local stat
	stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 0
	stat="${stat##*) }"
	# shellcheck disable=SC2086
	set -- $stat
	echo "${3}"
}

# Start "$@" in the background as its own process group's leader and record it, once it leads its group: until the
# forked shell has exec'd setsid it is still in the caller's group, and a stop then would signal no group of its own.
start_owned() {
	setsid "$@" &
	local pid=$!
	for _ in $(seq 50); do
		[ "$(group_of "$pid")" = "$pid" ] && break
		sleep 0.02
	done
	APP_PIDS+=("$pid:$(start_of "$pid")")
}

# Whether the recorded "pid:start" $1 still names the process it recorded.
owned() {
	local pid="${1%%:*}" start="${1##*:}"
	[ -n "$start" ] && [ "$(start_of "$pid")" = "$start" ]
}

# Stop every recorded group still owned: SIGTERM, up to 3 s to exit, then SIGKILL, each sent only while owned.
stop_owned() {
	local entry
	for entry in "${APP_PIDS[@]}"; do
		owned "$entry" && kill -TERM -- "-${entry%%:*}" 2>/dev/null || true
	done
	for _ in $(seq 30); do
		local left=0
		for entry in "${APP_PIDS[@]}"; do
			owned "$entry" && left=1
		done
		[ "$left" = 0 ] && break
		sleep 0.1
	done
	for entry in "${APP_PIDS[@]}"; do
		owned "$entry" && kill -KILL -- "-${entry%%:*}" 2>/dev/null || true
	done
	APP_PIDS=()
}
