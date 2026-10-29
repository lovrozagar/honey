/**
 * The Java SDK's HTTP answers (bit 16 phase c1; the port of C#'s `http.response.test.ts`): a JSON answer decoded into
 * the operation's type, and an undecodable 2xx (truncated, or nested past the parser's depth) as the method's own
 * `DecodeException`; a deep error body kept as its status class with an empty envelope and a cut `Detail`; every
 * member the wire sent kept; a text answer as the body verbatim, asked for by its media type; a byte answer as its
 * length and digest; and a refused connection as an `ApiConnectionException` with no status, aimed at `REFUSED_URL`.
 * Driven through the `http` registry SDK's driver on the one client. The safe-mode legs (`http-safe` is not a c1
 * registry key), the deadline, the answer cap and the decompression are the errors.safe, c2 and W3 legs.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { JavaError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Json as WireJson, REFUSED_URL, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether Java is here: a missing toolchain fails where it is required and skips these legs elsewhere (java-env). */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

/** The call for `operation` at `path` with GET and `params`. */
const get = (operation: string, path: string, params?: Record<string, string>): Call => ({
	operation,
	params,
	route: { method: "GET", path },
})

const USER = get("users.get", "/users/{id}", { id: "1" })
const LABELS = get("labels.get", "/labels")
const SHAPE = get("shapes.get", "/shape")
const TEXT = get("text.get", "/text")
const FILE = get("files.get", "/files/{name}", { name: "x" })

/** A 200 JSON reply of `json`, and the data the driver observes for it. */
const found = (json: WireJson): Reply => ({ json, status: 200 })
const data = (json: Extract<Observed, { kind: "data" }>["data"]): Observed => ({
	data: json,
	kind: "data",
	status: 200,
})
/** A reply whose body claims JSON and is `text`. */
const claimed = (text: string, status = 200): Reply => ({
	headers: { "content-type": "application/json" },
	status,
	text,
})

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

/** A Java error as the trace records it: no inner, not canceled, the method's own throw, any display. */
const plain = (entry: Partial<JavaError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})

/** The method's DecodeException for a 2xx whose body does not decode (§5.6 pins its class, not its text). */
const UNDECODED = expect.objectContaining({
	canceled: false,
	chain: ["DecodeException", "SdkException", "HoneyException"],
	type: "DecodeException",
	via: "return",
})

/** The `http` registry SDK with the driver aimed at it, which must build (javac's diagnostics say why when not). */
function driven(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("http")
	expect(sdk.javac.diagnostics, sdk.javac.diagnostics.join("\n")).toEqual([])
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run under `options` against a server answering `replies`: the run and the hops. */
async function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { script: options.script })
		return { hops: [...server.hops], run }
	})
}
type Driven = Awaited<ReturnType<typeof drive>>

/** A decoding run: each call's error, the urls hit, what was observed, the exit status. */
const decoding = ({ hops, run }: Driven) => ({
	calls: run.trace?.calls.map(({ error }) => ({ error })),
	hops: hops.map((h) => h.url),
	observed: run.observed,
	status: run.status,
})

/** A run as the plain legs pin it: the urls hit, what was observed, the exit status. */
const wire = ({ hops, run }: Driven) => ({ hops: hops.map((h) => h.url), observed: run.observed, status: run.status })

/** A 2xx that did not decode as the grid observes it (bit 21 i0): the DecodeException, its status the raw box's. */
const UNDECODABLE = { kind: "decode", status: 200 }

/** A decoding run of a user and then a truncated body: the second call's DecodeException, observed as undecodable. */
const truncated = () => ({
	calls: [{ error: undefined }, { error: UNDECODED }],
	hops: ["/users/1", "/users/1"],
	observed: [data({ id: "u1" }), UNDECODABLE],
	status: 0,
})

/** JSON nested past any parser's depth. */
const DEEP = "[".repeat(100_000)

describe.skipIf(!JAVA)(
	"a JSON answer decodes into the operation's type; an undecodable one is the method's error",
	SLOW,
	() => {
		/* port: csharp http.response.test.ts (the decoded user, then a truncated body as DecodeException) */
		it("the decoded user, then a truncated body as DecodeException", async () => {
			const run = await drive([found({ id: "u1" }), claimed('{"id":')], [USER, USER], { script: {} })
			expect(decoding(run), run.run.stderr).toEqual(truncated())
		})

		/* port: csharp http.response.test.ts (a 2xx nested past the depth; a 404 of it keeps its class and a cut Detail) */
		it("a 2xx nested past the parser's depth is DecodeException; a 404 of it keeps its class, a cut Detail, an empty envelope", async () => {
			const script: Script = { calls: [null, { envelope: true }] }
			const run = await drive([claimed(DEEP), claimed(DEEP, 404)], [USER, USER], { script })
			const detail = `${"[".repeat(512)}…`
			expect(decoding(run), run.run.stderr).toEqual({
				calls: [
					{ error: UNDECODED },
					{
						error: plain({
							chain: ["NotFoundException", "ApiException", "SdkException", "HoneyException"],
							envelope: { extraKeys: [] },
							key: null,
							keyMember: null,
							message: detail,
							status: 404,
							text: `HTTP 404: ${detail}`,
							type: "NotFoundException",
						}),
					},
				],
				hops: ["/users/1", "/users/1"],
				observed: [UNDECODABLE, expect.objectContaining({ errorKey: null, kind: "error", status: 404 })],
				status: 0,
			})
		})
	},
)

describe.skipIf(!JAVA)("a decoded answer keeps every member the wire sent", SLOW, () => {
	/* port: csharp http.response.test.ts (the additional properties beside a declared field, each union variant's own) */
	it("the additional properties beside a declared field, each union variant's own", async () => {
		const labels = { color: "red", name: "x" }
		const circle = { kind: "circle", radius: 2.5 }
		const square = { kind: "square", side: 3 }
		const run = await drive([found(labels), found(circle), found(square)], [LABELS, SHAPE, SHAPE])
		expect(wire(run), run.run.stderr).toEqual({
			hops: ["/labels", "/shape", "/shape"],
			observed: [data(labels), data(circle), data(square)],
			status: 0,
		})
	})
})

describe.skipIf(!JAVA)("a text answer is the body as a string, asked for by its media type", SLOW, () => {
	/* port: csharp http.response.test.ts (a text/plain body verbatim, never JSON-decoded, accept text/plain) */
	it("a text/plain body verbatim, never JSON-decoded, accept text/plain", async () => {
		const reply: Reply = { headers: { "content-type": "text/plain" }, status: 200, text: '{"a":1}' }
		const { hops, run } = await drive([reply], [TEXT])
		expect(
			{ accept: hops.map((h) => h.headers.accept), observed: run.observed, status: run.status },
			run.stderr,
		).toEqual({ accept: ["text/plain"], observed: [data('{"a":1}')], status: 0 })
	})
})

describe.skipIf(!JAVA)("a byte answer is its length and digest, never decoded", SLOW, () => {
	/* port: csharp http.test.ts (files.get's bytes, four of them: the observed kind bytes) */
	it("four bytes 0..3 observed as kind bytes with their size and sha256", async () => {
		const file: Reply = { bytes: 4, headers: { "content-type": "application/octet-stream" }, status: 200 }
		const { hops, run } = await drive([file], [FILE])
		expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
			hops: ["/files/x"],
			observed: [{ kind: "bytes", sha256: sha256(Buffer.from([0, 1, 2, 3])), size: 4, status: 200 }],
		})
	})
})

describe.skipIf(!JAVA)("a refused connection is a transport error, never a status", SLOW, () => {
	/* port: csharp http.response.test.ts (ApiConnectionException with the connect failure as its inner; no status) */
	it("ApiConnectionException with the connect failure as inner, and no status", async () => {
		/* REFUSED_URL, never a closed server's URL: a freed port a concurrent test's server may take first */
		const run = await driven().runCalls({ calls: [USER], setup: {} }, { url: REFUSED_URL }, { script: {} })
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed, status: run.status }, run.stderr).toEqual({
			error: plain({
				chain: ["ApiConnectionException", "HoneyException"],
				inner: "ConnectException",
				text: expect.any(String),
				type: "ApiConnectionException",
			}),
			observed: [{ kind: "transport" }],
			status: 0,
		})
	})
})
