/**
 * One claim loop on both process runtimes: a child on Node and on Bun sends to a memory store, and
 * the handler closes the consumer. The loop is what keeps the child alive, so the child exiting
 * cleanly proves `close` from inside a handler stopped it with nothing left behind.
 */
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"

const url = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../../src", path)).href

const CHILD = `
const { defineConsumer, queueContract, queueMessage } = await import(${JSON.stringify(url("queue/define.ts"))})
const { memoryQueueStore, serveQueue } = await import(${JSON.stringify(url("queue/serve.ts"))})
const { SILENT } = await import(${JSON.stringify(url("telemetry/logger.ts"))})
const jobs = queueContract({ job: queueMessage() })
const store = memoryQueueStore()
await jobs.send(store, "job", 7)
const running = serveQueue(
	defineConsumer()(jobs, {
		handlers: {
			job: ({ data, message }) => {
				console.log("ran", data, message.attempts)
				void running.close()
			},
		},
		logger: SILENT,
	}),
	{ env: {}, pollMs: 10, store },
)
`

const run = (cmd: string, args: readonly string[]) =>
	new Promise<{ code: number | null; out: string }>((done) => {
		const child = spawn(cmd, [...args, CHILD], { stdio: ["ignore", "pipe", "inherit"] })
		let out = ""
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString()
		})
		child.once("close", (code) => done({ code, out }))
	})

describe("serveQueue on each process runtime", () => {
	it.each([
		["node", ["--input-type=module", "-e"]],
		["bun", ["-e"]],
	])(
		"%s runs a message and exits once closed",
		async (cmd, args) => {
			expect(await run(cmd, args)).toEqual({ code: 0, out: "ran 7 1\n" })
		},
		SPAWN_TIMEOUT,
	)
})
