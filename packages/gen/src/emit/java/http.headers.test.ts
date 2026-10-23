/**
 * The Java SDK's header layers (bit 16 phase c1, W4; the C# `http.headers.test.ts` port, Fe7's fold, Fc5): the layers
 * fold case-insensitively into one map, so a request hook's header replaces the layer of the same name whatever its
 * casing, the credential included, and a per-call header replaces the config's: one raw line per name, on every hop.
 * A value a hook sets is checked on the final map, so CR/LF never reaches the wire. A restricted header (Qc6) a hook
 * or the caller sets raises the SDK's own ConfigException naming it, never the JDK's IllegalArgumentException.
 * X-Request-Id is a replaceable base layer. C#'s consumer legs (a typed map argument, a C# hook) have no Java analog
 * in the c1 driver and are not written here.
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

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }
/** A script with one no-op request hook: it records the run's trace, so an error is readable. */
const TRACED: Script = { hooks: { request: [{}] } }
/** The restricted names the JDK refuses (Qc6). */
const RESTRICTED = ["Host", "Connection", "Content-Length", "Expect", "Upgrade"] as const
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The `http` SDK with the driver aimed at it, which must build. */
function httpSdk(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` under `setup` and `script` against a server answering `replies`: the run, the hops and their raw lines. */
async function drive(replies: readonly Reply[], calls: readonly Call[], setup: Setup = {}, script?: Script) {
	const sdk = httpSdk()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, { alt: server.alt, url: server.url }, { script })
		return { hops: [...server.hops], lines: [...server.rawHeaders], run }
	})
}

/** Each hop's raw header lines named `name`, their values as sent. */
const linesOf = (lines: readonly (readonly (readonly [string, string])[])[], name: string) =>
	lines.map((pairs) => pairs.filter(([line]) => line === name).map(([, value]) => value))

/** A script whose one request hook sets `name` to `value`. */
const setHeader = (name: string, value: string): Script => ({ hooks: { request: [{ setHeader: [name, value] }] } })

/** An error as the trace records it: no inner, not canceled, thrown by the method. */
const plain = (entry: Partial<JavaError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})

/** The SDK's refusal of the restricted header `name`: a ConfigException naming it, never the JDK's. */
const refused = (name: string) =>
	plain({
		chain: ["ConfigException", "HoneyException"],
		text: `the ${name} header is restricted and cannot be sent`,
		type: "ConfigException",
	})

describe.skipIf(!JAVA)("a request hook's header: one value per name, whatever its case (Fe7, Fc5)", SLOW, () => {
	/* port: csharp http.headers.test.ts "a request hook's header" (the layer leg) */
	it("a hook's x-trace over the config's X-Trace: one line, the hook's value", async () => {
		const { lines, run } = await drive([OK], [ECHO], { headers: { "X-Trace": "cfg" } }, setHeader("x-trace", "hook"))
		expect({ lines: linesOf(lines, "x-trace"), observed: run.observed }, run.stderr).toEqual({
			lines: [["hook"]],
			observed: [OK_DATA],
		})
	})

	/* port: csharp http.headers.test.ts "a request hook's header" (the credential leg) */
	it("a hook's authorization over the bearer credential: one line, the hook's value", async () => {
		const setup: Setup = { auth: { kind: "bearer", token: "cfg-token" } }
		const { lines, run } = await drive([OK], [ECHO], setup, setHeader("authorization", "Bearer from-hook"))
		expect({ lines: linesOf(lines, "authorization"), observed: run.observed }, run.stderr).toEqual({
			lines: [["Bearer from-hook"]],
			observed: [OK_DATA],
		})
	})

	/* §1 rules: the CR/LF/NUL check runs on the final map, after the hooks */
	it("refuses a hook's value holding CR/LF as ConfigException, nothing sent", async () => {
		const { hops, run } = await drive([], [ECHO], {}, setHeader("X-Bad", "a\r\nb"))
		expect({ error: run.trace?.calls[0]?.error, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			error: plain({
				chain: ["ConfigException", "HoneyException"],
				text: "the X-Bad header's value cannot be sent",
				type: "ConfigException",
			}),
			hops: 0,
			observed: [null],
		})
	})

	/* new: the JDK's builder refuses every other control character with a raw IllegalArgumentException that quotes the
	 * value; the SDK's ConfigException names the header and carries neither the value nor that refusal */
	it.each(["a\u0001b", "a\u007fb"])(
		"refuses a hook's value %j as ConfigException, the value nowhere in it, nothing sent",
		async (value) => {
			const { hops, run } = await drive([], [ECHO], {}, setHeader("X-Bad", value))
			expect(JSON.stringify(run.trace?.calls[0]?.error)).not.toContain(JSON.stringify(value).slice(1, -1))
			expect({ error: run.trace?.calls[0]?.error, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
				error: plain({
					chain: ["ConfigException", "HoneyException"],
					text: "the X-Bad header cannot be sent",
					type: "ConfigException",
				}),
				hops: 0,
				observed: [null],
			})
		},
	)
})

describe.skipIf(!JAVA)("a header name the JDK refuses: the SDK's ConfigException, never the JDK's", SLOW, () => {
	/* new: a per-call header named outside the token grammar is refused by name before anything is sent */
	it("refuses a per-call header named 'bad name' as ConfigException, nothing sent", async () => {
		const { hops, run } = await drive([], [{ ...ECHO, headers: { "bad name": "x" } }], {}, {})
		expect({ error: run.trace?.calls[0]?.error, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			error: plain({
				chain: ["ConfigException", "HoneyException"],
				text: "the bad name header cannot be sent",
				type: "ConfigException",
			}),
			hops: 0,
			observed: [null],
		})
	})
})

describe.skipIf(!JAVA)("a per-call header: it replaces the config's of any case, one line", SLOW, () => {
	/* port: csharp http.headers.test.ts (Fe7's fold) */
	it("sends the call's x-keep over the config's X-Keep as one line, and the config's when the call sets none", async () => {
		const calls = [{ ...ECHO, headers: { "x-keep": "c" } }, ECHO]
		const { lines, run } = await drive([OK, OK], calls, { headers: { "X-Keep": "k" } })
		expect({ lines: linesOf(lines, "x-keep"), observed: run.observed }, run.stderr).toEqual({
			lines: [["c"], ["k"]],
			observed: [OK_DATA, OK_DATA],
		})
	})
})

describe.skipIf(!JAVA)(
	"a restricted header (Qc6): the SDK's own ConfigException names it, never the JDK's",
	SLOW,
	() => {
		/* a hook's restricted name is refused on the final map, before anything is sent */
		it.each(RESTRICTED)("a hook setting %s is refused by name, nothing sent", async (name) => {
			const { hops, run } = await drive([], [ECHO], {}, setHeader(name, "x"))
			expect({ error: run.trace?.calls[0]?.error, hops: hops.length }, run.stderr).toEqual({
				error: refused(name),
				hops: 0,
			})
		})

		/* the caller's config header takes the same check as a hook's */
		it.each(RESTRICTED)("a config header %s is refused by name, nothing sent", async (name) => {
			const { hops, run } = await drive([], [ECHO], { headers: { [name]: "x" } }, TRACED)
			expect({ error: run.trace?.calls[0]?.error, hops: hops.length }, run.stderr).toEqual({
				error: refused(name),
				hops: 0,
			})
		})

		/* the per-call header takes the same check too */
		it.each(RESTRICTED)("a per-call header %s is refused by name, nothing sent", async (name) => {
			const { hops, run } = await drive([], [{ ...ECHO, headers: { [name]: "x" } }], {}, TRACED)
			expect({ error: run.trace?.calls[0]?.error, hops: hops.length }, run.stderr).toEqual({
				error: refused(name),
				hops: 0,
			})
		})

		/* the names the JDK allows pass the SDK's check and reach the wire as the hook set them */
		it("a hook's User-Agent reaches the wire as the one it set", async () => {
			const { hops, run } = await drive([OK], [ECHO], {}, setHeader("user-agent", "hooked"))
			expect({ agent: hops.map((h) => h.headers["user-agent"]), observed: run.observed }, run.stderr).toEqual({
				agent: ["hooked"],
				observed: [OK_DATA],
			})
		})
	},
)

describe.skipIf(!JAVA)("X-Request-Id: a replaceable base layer (Fc5)", SLOW, () => {
	/* the base layer: the SDK's own generated id when no layer names it */
	it("a request with no X-Request-Id sends a generated v4 one", async () => {
		const { hops, run } = await drive([OK], [ECHO])
		const id = hops[0]?.headers["x-request-id"] ?? ""
		expect({ observed: run.observed, v4: UUID_V4.test(id) }, run.stderr).toEqual({
			observed: [OK_DATA],
			v4: true,
		})
	})

	/* the config's value replaces the generated one, one line */
	it("the config's X-Request-Id replaces the generated one, as one line", async () => {
		const { lines, run } = await drive([OK], [ECHO], { headers: { "X-Request-Id": "cfg" } })
		expect({ lines: linesOf(lines, "x-request-id"), observed: run.observed }, run.stderr).toEqual({
			lines: [["cfg"]],
			observed: [OK_DATA],
		})
	})

	/* a per-call value replaces the config's, one line */
	it("a per-call X-Request-Id replaces the config's, as one line", async () => {
		const calls = [{ ...ECHO, headers: { "x-request-id": "call" } }]
		const { lines, run } = await drive([OK], calls, { headers: { "X-Request-Id": "cfg" } })
		expect({ lines: linesOf(lines, "x-request-id"), observed: run.observed }, run.stderr).toEqual({
			lines: [["call"]],
			observed: [OK_DATA],
		})
	})

	/* a hook's value replaces the config's, one line; the hook runs after the layers fold */
	it("a hook's X-Request-Id replaces the config's, as one line", async () => {
		const { lines, run } = await drive(
			[OK],
			[ECHO],
			{ headers: { "X-Request-Id": "cfg" } },
			setHeader("X-Request-Id", "hooked"),
		)
		expect({ lines: linesOf(lines, "x-request-id"), observed: run.observed }, run.stderr).toEqual({
			lines: [["hooked"]],
			observed: [OK_DATA],
		})
	})
})
