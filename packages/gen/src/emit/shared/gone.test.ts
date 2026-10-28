/**
 * The release check's own proof (__fixtures__/gone.ts): a Node program opens a held event stream, then asks for
 * the next reply, and lets the stream's connection go at one of four points. `release` lets it go before the next
 * request, as a stream dropped or cancelled mid-run does; `late` 100 ms after it, while it waits on the reply.
 * `teardown` holds it past its last request and lets it go as it shuts down, 200 ms before it exits: a runtime's
 * teardown closing a leaked connection (Rust's tokio runtime drops it a few ms before the process ends). `exit`
 * never lets it go: the kernel closes it at the exit.
 */
import { spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import { gone } from "./__fixtures__/gone.ts"
import { type RecordingServer, type Reply, recordingServer, served } from "./__fixtures__/recording-server.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"

type Mode = "exit" | "late" | "release" | "teardown"

const PROGRAM = `const http = require("node:http")
const [url, mode] = process.argv.slice(1)
const get = (path, then) => http.get(url + path, then)
const after = (stream) => {
	if (mode !== "teardown") return process.exit(0)
	stream.destroy()
	setTimeout(() => process.exit(0), 200)
}
get("/stream", (stream) =>
	stream.once("data", () => {
		if (mode === "release") stream.destroy()
		if (mode === "late") setTimeout(() => stream.destroy(), 100)
		get("/next", (res) => res.resume().on("end", () => after(stream)))
	}),
)`

/** The program in `mode` against `server`: resolves with its exit code once it ended. */
function program(server: RecordingServer, mode: Mode): Promise<number | null> {
	const child = spawn(process.execPath, ["-e", PROGRAM, server.url, mode], { stdio: "ignore" })
	return new Promise((resolve) => child.once("close", resolve))
}

const HELD: Reply = { sse: { end: "hold", steps: ["data: 1\n\n"] }, status: 200 }
const NEXT: Reply = { json: {}, status: 200 }

/** The check the Rust stream legs used: poll every 10 ms until the run ended or stream 0's client left. */
async function oldCheck(server: RecordingServer, running: Promise<unknown>): Promise<boolean> {
	const state = { ended: false }
	const watched = running.finally(() => (state.ended = true))
	const left = () => server.streams[0]?.clientGone === true
	for (let i = 0; i < 500 && !(state.ended || left()); i++) await new Promise((wake) => setTimeout(wake, 10))
	const seen = !state.ended && left()
	await watched
	return seen
}

/** Whether `mode`'s program released stream 0 while it still ran, as `oldCheck` decides it. */
const oldVerdict = (mode: Mode) => served([HELD, NEXT], (server) => oldCheck(server, program(server, mode)))

/** Whether `mode`'s program released stream 0 while it still ran, as gone.ts decides it (the next reply held ≤ 300 ms). */
async function verdict(mode: Mode) {
	const check = gone(NEXT, { withinMs: 300 })
	const code = await served([HELD, check.reply], (server) => program(server, mode))
	return { code, released: check.released() }
}

describe("the release check: a close the program's exit made is no release", () => {
	it(
		"decides each program's release as it happened: only the one that let go before its next request",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const verdicts = {
				exit: await verdict("exit"),
				release: await verdict("release"),
				teardown: await verdict("teardown"),
			}
			expect(verdicts).toEqual({
				exit: { code: 0, released: false },
				release: { code: 0, released: true },
				teardown: { code: 0, released: false },
			})
		},
	)

	it(
		"is what the old check got wrong: it passed the leak a teardown closes 200 ms before the exit",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			expect(await oldVerdict("teardown")).toBe(true)
		},
	)
})

describe("the release check's held reply: when it goes out", () => {
	it(
		"answers the held reply once a close that came after it is seen, not at the bound",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const check = gone(NEXT, { withinMs: 4_000 })
			const start = performance.now()
			await served([HELD, check.reply], (server) => program(server, "late"))
			expect({ fast: performance.now() - start < 2_000, released: check.released() }).toEqual({
				fast: true,
				released: true,
			})
		},
	)

	it("is no release when the stream it names was never opened", async () => {
		const check = gone(NEXT, { stream: 5 })
		const answered = await served([check.reply], async (server) => (await fetch(server.url)).status)
		expect({ answered, released: check.released() }).toEqual({ answered: 200, released: false })
	})

	it("never answers a reply still held when the server closes, and ends the hold at once", async () => {
		const check = gone(NEXT)
		const server = await recordingServer([HELD, check.reply])
		const stream = await fetch(server.url)
		const next = fetch(server.url).then(
			() => "answered",
			() => "refused",
		)
		while (server.hops.length < 2) await new Promise((wake) => setTimeout(wake, 5))
		const start = performance.now()
		await server.close()
		expect({ next: await next, quick: performance.now() - start < 1_000, released: check.released() }).toEqual({
			next: "refused",
			quick: true,
			released: false,
		})
		await stream.body?.cancel().catch(() => undefined)
	})

	it("refuses a reply naming both waits", async () => {
		const both: Reply = { ...gone(NEXT).reply, delayMs: 10 }
		await expect(recordingServer([both])).rejects.toThrow("reply 0 names delayMs and afterLeft; give one wait")
	})
})
