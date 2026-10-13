import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import net from "node:net"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * Raw-socket conformance: the same bytes on the wire get the same routing decision and the
 * same `ctx.path` on every runtime, whether the runtime parses the request URL before the app
 * sees it (Bun, Node through the adapter) or builds it from `Host` and the raw target (Deno).
 */

const SERVER = fileURLToPath(new URL("./server.ts", import.meta.url))

const RUNTIMES: Record<string, string[]> = {
	bun: ["bun", SERVER],
	deno: ["deno", "run", "-A", SERVER],
	/* strict: an unhandled rejection in the server is a crash the test sees, never a warning */
	node: ["node", "--unhandled-rejections=strict", SERVER],
}

/* the case table's key for a runtime: Bun's URL handling changed in 1.4 */
function variantOf(name: string): string {
	if (name !== "bun") return name
	const version = spawnSync("bun", ["--version"], { encoding: "utf-8" }).stdout.trim()
	const [major = 0, minor = 0] = version.split(".").map(Number)
	return major > 1 || (major === 1 && minor >= 4) ? "bun>=1.4" : "bun"
}

function available(cmd: string): boolean {
	return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0
}

type Outcome = { path?: string; pattern?: string; rest?: string; scope?: boolean; status: number }

type Case = { expect: Outcome; host?: string; target: string; only?: Partial<Record<string, Outcome>> }

const BAD: Outcome = { status: 400 }
const SECRET: Outcome = { path: "/admin/secret", pattern: "/admin/secret", scope: true, status: 200 }

const CASES: Case[] = [
	{ expect: { path: "/admin/secret", pattern: "/admin/secret", scope: true, status: 200 }, target: "//admin/secret" },
	{
		expect: { path: "/admin/secret", pattern: "/admin/secret", scope: true, status: 200 },
		target: "/a/../admin/secret",
	},
	{
		expect: { path: "/admin/secret", pattern: "/admin/secret", scope: true, status: 200 },
		target: "/%2e%2e/admin/secret",
	},
	{
		expect: { path: "/admin/secret", pattern: "/admin/secret", scope: true, status: 200 },
		target: "/./admin/./secret",
	},
	{ expect: { path: "/admin/secret", pattern: "/admin/secret", scope: true, status: 200 }, target: "/admin\\secret" },
	{ expect: { path: "/files/a/c", pattern: "/files/*rest", rest: "a/c", status: 200 }, target: "/files/a/./b/../c" },
	{
		expect: { path: "/admin/secret", pattern: "/admin/secret", scope: true, status: 200 },
		target: "/files/../admin/secret",
	},
	{ expect: BAD, target: "/files/..%2fadmin%2fsecret" },
	{ expect: BAD, target: "/files/a%5Cb" },
	{ expect: { path: "/files/%C3%A9", pattern: "/files/*rest", rest: "é", status: 200 }, target: "/files/%C3%A9" },
	/* Node's HTTP parser rejects raw non-ASCII bytes in the target before the app sees them */
	{
		expect: { path: "/files/%C3%A9", pattern: "/files/*rest", rest: "é", status: 200 },
		only: { node: BAD },
		target: "/files/é",
	},
	{ expect: { path: "/files/a%20b", pattern: "/files/*rest", rest: "a b", status: 200 }, target: "/files/a%20b" },
	{ expect: { path: "/", pattern: "/", status: 200 }, target: "/files/%2e%2e" },
	/* absolute-form: the authority in the target is not routing input */
	{ expect: { status: 404 }, target: "http://admin/secret" },
	{ expect: { path: "/files/x", pattern: "/files/*rest", rest: "x", status: 200 }, target: "http://other/files/x" },
	{ expect: BAD, target: "*" },
	/* hostile Host values never change the routed path. Node, Deno and Bun before 1.4 reject them
	 * (Deno and old Bun build request.url from Host, so they must); Bun 1.4+ routes on the target
	 * and ignores them. */
	{ expect: BAD, host: "evil.com/admin/secret?", only: { "bun>=1.4": { status: 404 } }, target: "/nothing" },
	{ expect: BAD, host: "h/admin", only: { "bun>=1.4": { status: 404 } }, target: "/users" },
	...["a b", "h:99999", "h?", "h#x"].map((host): Case => ({
		expect: BAD,
		host,
		only: { "bun>=1.4": SECRET },
		target: "/admin/secret",
	})),
	{
		expect: { path: "/admin/secret", pattern: "/admin/secret", scope: true, status: 200 },
		host: "[::1]:8080",
		target: "/admin/secret",
	},
	{
		expect: { path: "/admin/secret", pattern: "/admin/secret", scope: true, status: 200 },
		host: "API.Example.com.",
		target: "/admin/secret",
	},
]

function send(port: number, target: string, host: string): Promise<Outcome> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1")
		const chunks: Buffer[] = []
		const timer = setTimeout(() => {
			socket.destroy()
			reject(new Error(`timeout: ${target}`))
		}, 5_000)
		socket.on("data", (d) => chunks.push(d))
		socket.on("error", reject)
		socket.on("close", () => {
			clearTimeout(timer)
			const text = Buffer.concat(chunks).toString("utf8")
			const status = Number(text.slice(9, 12))
			const split = text.indexOf("\r\n\r\n")
			const head = text.slice(0, split).toLowerCase()
			let body = text.slice(split + 4)
			if (head.includes("transfer-encoding: chunked")) {
				const nl = body.indexOf("\r\n")
				body = body.slice(nl + 2, nl + 2 + Number.parseInt(body.slice(0, nl), 16))
			}
			if (status !== 200) return resolve({ status })
			const json = JSON.parse(body) as { params: { rest?: string }; path: string; pattern: string }
			const outcome: Outcome = { path: json.path, pattern: json.pattern, status }
			if (json.params.rest !== undefined) outcome.rest = json.params.rest
			if (head.includes("\r\nx-scope: admin")) outcome.scope = true
			resolve(outcome)
		})
		socket.write(Buffer.from(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`, "utf8"))
	})
}

for (const [name, argv] of Object.entries(RUNTIMES)) {
	describe.skipIf(!available(argv[0]))(`request target conformance — ${name}`, () => {
		let child: ChildProcess
		let port = 0
		const variant = variantOf(name)

		beforeAll(async () => {
			child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "ignore"] })
			port = await new Promise<number>((resolve, reject) => {
				let out = ""
				child.stdout?.on("data", (d: Buffer) => {
					out += d.toString()
					const m = /PORT (\d+)/.exec(out)
					if (m) resolve(Number(m[1]))
				})
				child.once("exit", (code) => reject(new Error(`${name} server exited with ${code}`)))
			})
		}, 30_000)

		afterAll(() => {
			child?.kill()
		})

		for (const c of CASES) {
			const host = c.host ?? "h"
			it(`${c.target}  Host: ${host}`, async () => {
				const expected = c.only?.[variant] ?? c.only?.[name] ?? c.expect
				expect(await send(port, c.target, host)).toEqual(expected)
			})
		}
	})
}
