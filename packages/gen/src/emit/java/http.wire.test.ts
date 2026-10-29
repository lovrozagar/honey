/**
 * The Java SDK's wire legs (bit 16 phase c2, W7; the C# decode and protocol legs of `http.test.ts` and
 * `http.response.test.ts`). R8: a gzip or deflate answer decodes, the request offers `gzip, deflate` and never brotli,
 * and a decoded size over `maxResponseBytes` is an ApiConnectionException (0 is none, 100 MiB when unset). A 512 MiB
 * bomb, streamed by the recording server, is refused at its cap under a 64 MiB heap. R1: the exchange is HTTP/1.1 only,
 * shown by the absence of an h2c upgrade. Qc6: a restricted header set by config, per call or by a hook raises
 * ConfigException naming it, and the process-global `jdk.httpclient.allowRestrictedHeaders` is never set.
 * A leg is labelled `new` (red first) or `pin` (green on write, behavior c1 already ships). A `new` leg that is green
 * on write is reported, never relabelled here.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { JavaError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether the JDK is here: a missing JDK fails where it is required and skips these legs elsewhere (java-env). */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const MIB = 1024 * 1024
/** The default `maxResponseBytes` (100 MiB, C#'s MaxResponseBytes default). */
const DEFAULT_CAP = 100 * MIB
/** Just under 512 MiB of decoded bytes: a bomb whose gzip is a few KiB (V8 caps a string near 512 MiB). */
const BOMB = 512 * MIB - 1024
/** The heap a bounded decode fits in: a decoder that holds the body, rather than counting it, dies here. */
const HEAP_64M = ["-Xmx64m"]

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }
/** The restricted names the JDK refuses (Qc6). */
const RESTRICTED = ["Host", "Connection", "Content-Length", "Expect", "Upgrade"] as const

/** The http SDK with the driver aimed at it, which must build (javac's diagnostics say why when not). */
function httpSdk(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** A JSON answer of `{"ok":true}` padded with `spaces` trailing spaces: its decoded size is 11 + `spaces`. */
const padded = (spaces: number) => `{"ok":true}${" ".repeat(spaces)}`

/** A Java error as the trace records it: no inner, not canceled, the method's own throw, any display. */
const plain = (entry: Partial<JavaError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})

/** The SDK's refusal of a decoded answer over `limit` bytes: an ApiConnectionException stating the limit. */
const capped = (limit: number) =>
	plain({
		chain: ["ApiConnectionException", "HoneyException"],
		text: expect.stringContaining(String(limit)),
		type: "ApiConnectionException",
	})

/** The SDK's refusal of the restricted header `name`: a ConfigException naming it, never the JDK's. */
const refused = (name: string) =>
	plain({
		chain: ["ConfigException", "HoneyException"],
		text: `the ${name} header is restricted and cannot be sent`,
		type: "ConfigException",
	})

/** A 200 JSON answer whose text is `text`, encoded as `coding` says (none, gzip or deflate). */
const answer = (text: string, coding: { readonly deflate?: true; readonly gzip?: true } = {}): Reply => ({
	...coding,
	headers: { "content-type": "application/json" },
	status: 200,
	text,
})

/** `calls` run on the http SDK against `url` (the driver's own run), under `script`, `setup` and `opts`. */
const runOn = (
	url: string,
	calls: readonly Call[],
	opts: {
		readonly script?: Script
		readonly setup?: Setup
		readonly jvmArgs?: readonly string[]
		readonly probe?: true
	} = {},
) =>
	httpSdk().runCalls(
		{ calls, setup: opts.setup ?? {} },
		{ url },
		{ jvmArgs: opts.jvmArgs, probe: opts.probe, script: opts.script ?? {} },
	)

describe.skipIf(!JAVA)(
	"R8: a gzip or deflate answer decodes; the request offers gzip and deflate, never brotli",
	SLOW,
	() => {
		/* new: c1 sends no Accept-Encoding and hands a gzip body to the JSON decoder raw */
		it("a gzip answer decodes into the operation's type", async () => {
			const run = await served([answer(padded(2), { gzip: true })], (server) => runOn(server.url, [ECHO]))
			expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({ observed: [OK_DATA], status: 0 })
		})

		/* new: c1 has no deflate decode, so a deflate answer is undecodable JSON */
		it("a deflate answer decodes into the operation's type", async () => {
			const run = await served([answer(padded(2), { deflate: true })], (server) => runOn(server.url, [ECHO]))
			expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({ observed: [OK_DATA], status: 0 })
		})

		/* new: c1 sends no Accept-Encoding header at all; the SDK offers gzip and deflate, never brotli */
		it("the request offers exactly gzip, deflate: brotli is never offered", async () => {
			const hops = await served([OK], async (server) => {
				await runOn(server.url, [ECHO])
				return [...server.hops]
			})
			expect(hops.map((h) => h.headers["accept-encoding"])).toEqual(["gzip, deflate"])
		})
	},
)

describe.skipIf(!JAVA)("R8: a decoded size over maxResponseBytes is ApiConnectionException; 0 is none", SLOW, () => {
	/* new: no decoded-byte cap exists in c1, and the driver refuses the maxResponseBytes script key */
	it("512 on a 2,011-byte decoded answer sent as a few dozen bytes is ApiConnectionException, observed as transport", async () => {
		const run = await served([answer(padded(2000), { gzip: true })], (server) =>
			runOn(server.url, [ECHO], { script: { config: { maxResponseBytes: 512 } } }),
		)
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
			error: capped(512),
			observed: [{ kind: "transport" }],
		})
	})

	/* new: the same answer decodes under the cap of 0, which is none */
	it("0 is none: the same 2,011-byte decoded answer decodes", async () => {
		const run = await served([answer(padded(2000), { gzip: true })], (server) =>
			runOn(server.url, [ECHO], { script: { config: { maxResponseBytes: 0 } } }),
		)
		expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({ observed: [OK_DATA], status: 0 })
	})

	/* new: an unset cap is 100 MiB, and a 101 MiB decoded answer is refused at it */
	it("unset, the cap is 100 MiB: a 101 MiB decoded answer is ApiConnectionException at 104857600 bytes", async () => {
		const reply: Reply = {
			bytes: DEFAULT_CAP + MIB,
			gzip: true,
			headers: { "content-type": "application/json" },
			status: 200,
		}
		const run = await served([reply], (server) => runOn(server.url, [ECHO]))
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
			error: capped(DEFAULT_CAP),
			observed: [{ kind: "transport" }],
		})
	})

	/* new: a 512 MiB bomb under the default cap is refused at the cap, and a 64 MiB heap holds the bounded read */
	it("a 512 MiB bomb under the default cap is refused at the cap in a 64 MiB heap", async () => {
		const reply: Reply = { bytes: BOMB, gzip: true, headers: { "content-type": "application/json" }, status: 200 }
		const run = await served([reply], (server) => runOn(server.url, [ECHO], { jvmArgs: HEAP_64M }))
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
			error: capped(DEFAULT_CAP),
			observed: [{ kind: "transport" }],
		})
	})
})

describe.skipIf(!JAVA)("bit 19 b1: a bomb for every encoding the SDK offers", SLOW, () => {
	/* gzip's bombs are R8's legs; deflate, the other encoding offered, gets its own */
	it("a deflate bomb (64 MiB streamed) past a 1 MiB cap is ApiConnectionException at the cap, observed as transport", async () => {
		const reply: Reply = {
			bytes: 64 * MIB,
			deflate: true,
			headers: { "content-type": "application/json" },
			status: 200,
		}
		const run = await served([reply], (server) =>
			runOn(server.url, [ECHO], { script: { config: { maxResponseBytes: MIB } } }),
		)
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
			error: capped(MIB),
			observed: [{ kind: "transport" }],
		})
	})
})

describe.skipIf(!JAVA)("R1: the exchange is HTTP/1.1 only", SLOW, () => {
	/* pin: c1's Flight pins every request to HTTP_1_1, so no h2c upgrade is offered */
	it("no Upgrade, HTTP2-Settings or Connection: Upgrade header reaches the wire", async () => {
		const { hops, lines } = await served([OK], async (server) => {
			await runOn(server.url, [ECHO])
			return { hops: [...server.hops], lines: [...server.rawHeaders] }
		})
		const h2c = lines
			.flat()
			.filter(
				([name, value]) =>
					name === "upgrade" || name === "http2-settings" || (name === "connection" && /upgrade/i.test(value)),
			)
			.map(([name]) => name)
		expect({ h2c, hops: hops.length }).toEqual({ h2c: [], hops: 1 })
	})
})

describe.skipIf(!JAVA)(
	"Qc6: a restricted header is refused by name from every source; the property is never set",
	SLOW,
	() => {
		/* pin: c1's Flight refuses a restricted name from a config header, before anything is sent */
		it.each(RESTRICTED)("a config header %s is ConfigException naming it, nothing sent", async (name) => {
			const { hops, run } = await served([], async (server) => ({
				hops: [...server.hops],
				run: await runOn(server.url, [ECHO], { setup: { headers: { [name]: "x" } } }),
			}))
			expect({ error: run.trace?.calls[0]?.error, hops: hops.length }, run.stderr).toEqual({
				error: refused(name),
				hops: 0,
			})
		})

		/* pin: c1's Flight refuses a restricted name from a per-call map, before anything is sent */
		it.each(RESTRICTED)("a per-call header %s is ConfigException naming it, nothing sent", async (name) => {
			const calls = [{ ...ECHO, headers: { [name]: "x" } }]
			const { hops, run } = await served([], async (server) => ({
				hops: [...server.hops],
				run: await runOn(server.url, calls),
			}))
			expect({ error: run.trace?.calls[0]?.error, hops: hops.length }, run.stderr).toEqual({
				error: refused(name),
				hops: 0,
			})
		})

		/* pin: the refused Host and an answered call leave the process property unset: the SDK never sets it */
		it("after a refused Host and an answered call, allowRestrictedHeaders is null in the process", async () => {
			const calls = [{ ...ECHO, headers: { Host: "x" } }, ECHO]
			const run = await served([OK], (server) => runOn(server.url, calls, { probe: true }))
			expect(
				{
					error: run.trace?.calls[0]?.error,
					observed: run.observed,
					property: run.stderr.includes("honey-probe allowRestrictedHeaders=null"),
				},
				run.stderr,
			).toEqual({ error: refused("Host"), observed: [null, OK_DATA], property: true })
		})
	},
)
