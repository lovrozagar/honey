/**
 * The honey-codegen bin's Bun handoff (bit 17 phase h): started by Node under `bun run` (a bun user agent, npm_execpath
 * a bun binary), it hands its arguments to that Bun once, marked so the child never hands off again; HONEY_NO_BUN_HANDOFF
 * keeps it from handing off at all; the child's exit code is its own, and a signal it gets reaches the child and ends
 * it by that signal; anything else (another user agent, an npm_execpath that is not a bun) runs on Node, no loop. A fake
 * `bun` records each call, then runs the real Bun or ends as the leg needs. Every child carries this file's mark, and the
 * last leg fails on any that outlived its leg.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { MARK_KEY, markOf, reap } from "../../src/gen/__fixtures__/survivors.ts"

const MARK = markOf()
const BIN = resolve(import.meta.dirname, "../../bin/honey-codegen.js")
const REAL_BUN = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim()

/** A fake `bun` in a fresh dir, logging `$HONEY_NO_BUN_HANDOFF $@` and its pid, then running `then`. */
function fakeBun(then: string): { bun: string; log: string; pid: string } {
	const dir = mkdtempSync(join(tmpdir(), "codegen-bun-"))
	const log = join(dir, "log")
	const pid = join(dir, "pid")
	writeFileSync(join(dir, "bun"), `#!/bin/sh\necho "$HONEY_NO_BUN_HANDOFF $*" >> ${log}\necho $$ > ${pid}\n${then}\n`, {
		mode: 0o755,
	})
	return { bun: join(dir, "bun"), log, pid }
}

/** Whether a run printed the CLI's own usage. */
const usage = (stdout: string) => stdout.startsWith("usage: honey-codegen generate")

/** The bin run by Node with `args`, as `bun run` would start it, over `env`. */
const underBunRun = (args: readonly string[], bun: string, env: NodeJS.ProcessEnv = {}) =>
	spawnSync(process.execPath, [BIN, ...args], {
		encoding: "utf8",
		env: {
			[MARK_KEY]: MARK,
			PATH: process.env.PATH,
			npm_config_user_agent: "bun/1.3.11 npm/? node/v24",
			npm_execpath: bun,
			...env,
		},
	})

describe("the bin's Bun handoff (phase h)", () => {
	it("hands its arguments to the Bun that started it, once, the child marked against handing off again", () => {
		const fake = fakeBun(`exec ${REAL_BUN} "$@"`)
		const ran = underBunRun(["--help"], fake.bun)
		expect([
			ran.status,
			ran.stdout.startsWith("usage: honey-codegen generate"),
			readFileSync(fake.log, "utf8"),
		]).toEqual([0, true, `1 ${BIN} --help\n`])
	})

	it("hands nothing off under HONEY_NO_BUN_HANDOFF, nor for another runtime or an npm_execpath that is not a bun", () => {
		const fake = fakeBun("exit 9")
		const runs = [
			underBunRun(["--help"], fake.bun, { HONEY_NO_BUN_HANDOFF: "1" }),
			underBunRun(["--help"], fake.bun, { npm_config_user_agent: "npm/10.9.2 node/v24.11.0 linux x64" }),
			underBunRun(["--help"], "/bin/true"),
		]
		/* each ran the CLI itself on Node: its usage printed, nothing handed to the fake */
		expect([runs.map((ran) => [ran.status, usage(ran.stdout)]), existsSync(fake.log)]).toEqual([
			[
				[0, true],
				[0, true],
				[0, true],
			],
			false,
		])
	})

	it("ends with the child's exit code", () => {
		const ran = underBunRun(["generate"], fakeBun("exit 7").bun)
		expect(ran.status).toBe(7)
	})

	it("passes a signal on to the child, and ends by that same signal", async () => {
		const fake = fakeBun("exec sleep 30")
		const parent = spawn(process.execPath, [BIN, "generate"], {
			env: { [MARK_KEY]: MARK, PATH: process.env.PATH, npm_config_user_agent: "bun/1.3.11", npm_execpath: fake.bun },
		})
		/* the latch: the fake bun has written its pid, so the child is running */
		await new Promise<void>((settle) => {
			const poll = setInterval(() => existsSync(fake.pid) && (clearInterval(poll), settle()), 10)
		})
		const ended = new Promise<NodeJS.Signals | null>((settle) => parent.on("exit", (_code, signal) => settle(signal)))
		parent.kill("SIGTERM")
		const signal = await ended
		const child = Number(readFileSync(fake.pid, "utf8"))
		const alive = (() => {
			try {
				process.kill(child, 0)
				return true
			} catch {
				return false
			}
		})()
		expect([signal, alive]).toEqual(["SIGTERM", false])
	}, 30_000)
})

describe("no process left behind (phase h)", () => {
	it("leaves no child of this file running: any that outlived its leg is killed and named", () => {
		expect(reap(MARK)).toEqual([])
	})
})
