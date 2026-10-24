/**
 * Processes a test file started that outlived their leg (bit 17 phase h): every child a file spawns carries the file's
 * own mark in its environment, inherited by anything it starts, so a leaked `honey-codegen` (a `--watch` left running,
 * a fake bun's sleep) is found by the mark alone and no other process on the machine is touched.
 */
import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"

/** The environment variable the mark is under. */
export const MARK_KEY = "HONEY_CODEGEN_TEST_MARK"

/** A fresh mark: one per test file. */
export const markOf = (): string => randomUUID()

/** The PIDs (never this process) whose environment holds `mark`; a process that ends or cannot be read is skipped. */
export function marked(mark: string): number[] {
	const entry = `${MARK_KEY}=${mark}`
	return readdirSync("/proc")
		.filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
		.filter((name) => {
			try {
				return readFileSync(`/proc/${name}/environ`, "latin1").split("\0").includes(entry)
			} catch {
				return false
			}
		})
		.map(Number)
}

/**
 * Each marked process, killed, scanning again until a scan finds none (a survivor may start another between a scan and
 * its kill): every PID that was alive, so a leg can fail naming them with nothing left behind.
 */
export function reap(mark: string, rounds = 100): number[] {
	const killed = new Set<number>()
	for (let round = 0; round < rounds; round++) {
		const alive = marked(mark)
		if (alive.length === 0) return [...killed]
		for (const pid of alive) {
			killed.add(pid)
			try {
				process.kill(pid, "SIGKILL")
			} catch {
				/* it ended between the scan and the kill */
			}
		}
	}
	throw new Error(`marked processes still starting after ${rounds} rounds of kills: ${marked(mark).join(" ")}`)
}
