/**
 * One timer on both process runtimes: a child on Node and on Bun moves its clock to just before a
 * minute, runs a schedule, and prints when the job ran. The timer is what keeps the child alive, so
 * the child exiting cleanly after `close` proves it was not unref'd and that `close` stopped it.
 */
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"

const url = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../../src", path)).href

const CHILD = `
const { defineCron } = await import(${JSON.stringify(url("cron/define.ts"))})
const { serveCron } = await import(${JSON.stringify(url("cron/serve.ts"))})
const { SILENT } = await import(${JSON.stringify(url("telemetry/logger.ts"))})
const realNow = Date.now
const started = realNow()
const shift = Math.ceil(started / 60000) * 60000 + 60000 - 300 - started
Date.now = () => realNow() + shift
const running = serveCron(
	defineCron({
		logger: SILENT,
		schedules: {
			"* * * * *": {
				job: async ({ scheduledAt, signal }) => {
					console.log("ran", scheduledAt.toISOString().slice(17), signal.aborted)
					void running.close()
				},
			},
		},
	}),
	{ env: {}, onError: (error) => console.log("failed", error), singleInstance: true },
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

describe("serveCron on each process runtime", () => {
	it.each([
		["node", ["--input-type=module", "-e"]],
		["bun", ["-e"]],
	])(
		"%s fires at the minute and exits once closed",
		async (cmd, args) => {
			expect(await run(cmd, args)).toEqual({ code: 0, out: "ran 00.000Z false\n" })
		},
		SPAWN_TIMEOUT,
	)
})
