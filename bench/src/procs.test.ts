/**
 * The bench's process ownership (procs.sh): an app is started as the leader of its own process group, recorded with
 * its start time, and stopped only while that pid still names the process it started, so a pid the kernel has
 * reused for another process is never signalled. No kill reaches a process by its port or as a stored pid's child.
 */
import { spawn, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = import.meta.dirname
const PROCS = join(SRC, "procs.sh")

/** Whether `pid` is alive (a zombie is not). */
function alive(pid: number): boolean {
	const stat = spawnSync("cat", [`/proc/${pid}/stat`], { encoding: "utf8" }).stdout
	return stat !== "" && !/^\d+ \(.*\) Z /.test(stat)
}

/** `script` run by bash with procs.sh sourced: its stdout, its lines. */
function bash(script: string): string[] {
	const ran = spawnSync("bash", ["-c", `set -e; source ${JSON.stringify(PROCS)}; ${script}`], { encoding: "utf8" })
	if (ran.status !== 0) throw new Error(`bash failed (${ran.status}): ${ran.stderr}`)
	return ran.stdout.split("\n").filter((line) => line !== "")
}

describe("the bench's process cleanup", () => {
	it("signals no process by port, by a stored pid's children, or with SIGKILL on a bare stored pid", () => {
		const texts = ["run.sh", "procs.sh"].map((name) => readFileSync(join(SRC, name), "utf8"))
		const banned = /\bpkill\b|\bfuser\b|\blsof\b|xargs\s+-r\s+kill|kill\s+-9\s+"\$pid"/
		expect(texts.map((text) => text.split("\n").filter((line) => banned.test(line) && !/^\s*#/.test(line)))).toEqual([
			[],
			[],
		])
	})

	it("starts an app as its own process group's leader and records its pid with its start time", () => {
		const [entry = "", group = ""] = bash(
			'start_owned sleep 30; e="${APP_PIDS[0]}"; echo "$e"; cut -d" " -f5 "/proc/${e%%:*}/stat"; stop_owned',
		)
		const [pid, start] = entry.split(":")
		expect([/^\d+$/.test(pid ?? ""), /^\d+$/.test(start ?? ""), group]).toEqual([true, true, pid])
	})

	it("stops its own app and the app's children, and leaves none alive", () => {
		const lines = bash(
			'start_owned bash -c "sleep 30 & echo \\$!; wait"; sleep 0.5; echo "${APP_PIDS[0]%%:*}"; stop_owned',
		)
		const pids = lines.filter((line) => /^\d+$/.test(line)).map(Number)
		expect([pids.length, pids.filter(alive)]).toEqual([2, []])
	})

	it("never signals a recorded pid whose start time no longer matches: the kernel reused it for another process", () => {
		const foreign = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
		const pid = foreign.pid as number
		try {
			bash(`APP_PIDS=("${pid}:1"); stop_owned`)
			expect(alive(pid)).toBe(true)
		} finally {
			process.kill(pid, "SIGTERM")
		}
	})
})
