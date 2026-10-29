/**
 * The TS SDK's HTTP version is its platform fetch's (bit 19 d2, ruled): it sends through `fetch`, and pinning a
 * version would need a runtime-specific dispatcher the portable runtime cannot import (Workers and browsers choose
 * their own). So unlike every other SDK, which pins HTTP/1.1, TS speaks what the platform negotiates, and this leg
 * records it per runtime against a server offering h2 and http/1.1 by ALPN, so a platform's change is a diff here,
 * never silent: Node 26's undici negotiates h2 (the documented exception), Bun 1.4.3 http/1.1.
 */
import { execFile } from "node:child_process"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { alpnServer, trusted } from "../shared/__fixtures__/alpn-server.ts"
import { emittedSdkEntry } from "./__fixtures__/emitted.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"

/** One JSON GET: the SDK method `ping.get`. */
const DOC = {
	info: { title: "Test", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/ping": {
			get: {
				operationId: "ping.get",
				responses: { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
			},
		},
	},
}

/** A program calling `ping.get` once on the SDK at `entry`, aimed at `url`. */
const CALL = (entry: string, url: string) => `const { TestSDK } = await import(${JSON.stringify(entry)})
await new TestSDK({ baseURL: ${JSON.stringify(url)} }).ping.get()
console.log("called")
`

/** What `runtime` printed running the call with `args` before it, the test CA trusted. */
function ran(runtime: readonly string[], program: string, ca: string) {
	return new Promise<{ status: number; stderr: string; stdout: string }>((resolve) => {
		const env = { ...process.env, NODE_EXTRA_CA_CERTS: ca }
		const [command, ...args] = runtime as [string, ...string[]]
		execFile(command, [...args, program], { encoding: "utf8", env, timeout: 120_000 }, (error, stdout, stderr) =>
			resolve({ status: error ? 1 : 0, stderr, stdout }),
		)
	})
}

describe("the TS SDK's HTTP version is its platform fetch's (bit 19 d2)", () => {
	it.each([
		/* node loads the emitted SDK's extensionless imports through jiti's loader, its fetch the platform's own */
		["node", [process.execPath, "--import", import.meta.resolve("jiti/register")], { alpn: "h2", version: "2.0" }],
		["bun", ["bun"], { alpn: "http/1.1", version: "1.1" }],
	] as const)(
		"%s: negotiates what its fetch offers, recorded",
		{ timeout: SPAWN_TIMEOUT },
		async (_name, runtime, negotiated) => {
			const server = await alpnServer()
			try {
				const entry = emittedSdkEntry(DOC)
				const program = join(dirname(entry), `version-call-${_name}.ts`)
				writeFileSync(program, CALL(entry, server.url))
				const run = await trusted(() => ran(runtime, program, process.env.SSL_CERT_FILE ?? ""))
				expect([run.status, run.stdout.trim(), server.seen()], run.stderr).toEqual([0, "called", [negotiated]])
			} finally {
				await server.close()
			}
		},
	)
})
