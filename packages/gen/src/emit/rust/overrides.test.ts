/**
 * Per-call overrides on the owning `Call` a method returns (contract 19 §5.7; G2/G3): `.header()` over the
 * client's `headers` for that call alone, `.timeout()` in place of the client's (zero: none), `.base_url()` to
 * another origin, and the raw response, read through `.with_response()` beside the answer and kept by an
 * error status's `ApiError`. Driven in both error modes on `http` and `http-safe`; the raw response's URL
 * after a redirect and the Opts without a `headers` field are consumer programs.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { consume, once, sections, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

/* cargo builds the crate's dependencies on a cold cache */
const CARGO = 600_000

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }

/* both error modes: a per-call override applies whatever the method returns */
const MODES = [
	["throw", "http"],
	["safe", "http-safe"],
] as const

/** The registry SDK `key` compiled with the driver, which must build. */
function driven(key: "http" | "http-safe"): DrivenRustSdk {
	const sdk = drivenRustSdk(key)
	expect(sdk.built, sdk.stderr).toBe(true)
	return sdk
}

/** `calls` run by `key`'s driver on one client under `setup` against a server answering `replies`. */
async function drive(key: "http" | "http-safe", replies: readonly Reply[], calls: readonly Call[], setup: Setup = {}) {
	const sdk = driven(key)
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, server)
		return { hops: [...server.hops], run }
	})
}

describe.skipIf(!RUST)("a per-call header (.header) over the client's headers", () => {
	// v0: fc7a1a3d78
	it.each(MODES)(
		"wins over the config's same name for that call only, every other config header inherited (%s)",
		async (_, key) => {
			const setup: Setup = { headers: { "X-Keep": "k", "X-Trace": "d" } }
			const calls = [{ ...ECHO, headers: { "x-trace": "a" } }, ECHO]
			const { hops, run } = await drive(key, [OK, OK], calls, setup)
			expect(
				{ headers: hops.map((h) => [h.headers["x-trace"], h.headers["x-keep"]]), observed: run.observed },
				run.stderr,
			).toEqual({
				headers: [
					["a", "k"],
					["d", "k"],
				],
				observed: [OK_DATA, OK_DATA],
			})
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("a per-call timeout (.timeout) in place of the client's", () => {
	// v0: f953b89b99
	it.each(MODES)(
		"ends the call as a timeout when it is shorter than the config's (%s)",
		async (_, key) => {
			const slow: Reply = { ...OK, delayMs: 1000 }
			const { hops, run } = await drive(key, [slow], [{ ...ECHO, timeoutMs: 50 }], { timeoutMs: 10_000 })
			expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({
				hops: 1,
				observed: [{ kind: "timeout" }],
			})
		},
		CARGO,
	)

	// v0: f953b89b99
	it.each(MODES)(
		"removes the config's bound for that call only when zero (Duration::ZERO), the client untouched (%s)",
		async (_, key) => {
			const slow: Reply = { ...OK, delayMs: 300 }
			const calls = [{ ...ECHO, timeoutMs: 0 }, ECHO]
			const { hops, run } = await drive(key, [slow, slow], calls, { timeoutMs: 100 })
			expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({
				hops: 2,
				observed: [OK_DATA, { kind: "timeout" }],
			})
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("a per-call base URL (.base_url)", () => {
	it.each(MODES)(
		"sends that call to the other origin and the next to the config's (%s)",
		async (_, key) => {
			const { hops, run } = await drive(key, [OK, OK], [{ ...ECHO, origin: "alt" }, ECHO])
			expect({ hops: hops.map((h) => [h.origin, h.url]), observed: run.observed }, run.stderr).toEqual({
				hops: [
					["alt", "/echo"],
					["primary", "/echo"],
				],
				observed: [OK_DATA, OK_DATA],
			})
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("the raw response: .with_response() beside the answer, and an error status's ApiError", () => {
	it.each(MODES)(
		"keeps a 200's status, every header and the body as sent beside the decoded answer (%s)",
		async (_, key) => {
			const reply: Reply = { headers: { "x-total": "3" }, json: { id: "i1", name: "n" }, status: 200 }
			const { hops, run } = await drive(key, [reply], [{ ...ITEM, raw: true }])
			expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
				hops: ["/items/i1"],
				observed: [
					{
						body: '{"id":"i1","name":"n"}',
						headers: expect.objectContaining({
							"content-length": "22",
							"content-type": "application/json",
							"x-total": "3",
						}),
						kind: "raw",
						status: 200,
					},
				],
			})
		},
		CARGO,
	)

	it.each(MODES)(
		"keeps an error status's response and its body too (%s)",
		async (_, key) => {
			const reply: Reply = { headers: { "x-total": "0" }, json: { message: "gone" }, status: 404 }
			const { run } = await drive(key, [reply], [{ ...ITEM, raw: true }])
			expect(run.observed, run.stderr).toEqual([
				{
					body: '{"message":"gone"}',
					headers: expect.objectContaining({ "content-type": "application/json", "x-total": "0" }),
					kind: "raw",
					status: 404,
				},
			])
		},
		CARGO,
	)
})

/** A safe-mode consumer reading `hop.get`'s raw response after a same-origin 302 to `/echo`. */
const RAW = sections({
	raw: `    let c = client(base)?;
    let (r, raw) = c.hop().get(&sdk::HopGetOpts::default()).with_response().await?;
    let _: (&sdk::SdkResult<sdk::HopGetResponse>, &sdk::RawResponse) = (&r, &raw);
    let kind = raw.headers.get("content-type").and_then(|v| v.to_str().ok());
    n.note(format!("raw {} {} {kind:?}", raw.status, raw.url.path()));
    n.note(format!("body {}", raw.body == br#"{"ok":true}"#.as_slice()));
    let data = r.data.as_ref().map(|d| d.ok);
    n.note(format!("result {} {} {} {data:?}", r.is_ok(), r.status, r.response.url == raw.url));`,
})

/** The `raw` program run once against a 302 to `/echo` and its answer, with the hops it sent. */
const raw = once(() =>
	served([{ redirect: { origin: "primary", path: "/echo" }, status: 302 }, OK], async (server) => {
		const run = await consume("http-safe", "raw", { ...RAW, base: server.url })
		return { hops: server.hops.map((h) => `${h.origin} ${h.method} ${h.url}`), run }
	}),
)

describe.skipIf(!RUST)("RawResponse: the answer's status, headers, body and the URL it came from", () => {
	// v0: 7db7423d4c
	it(
		"is the last hop's after a redirect, and the safe-mode SdkResult holds the same response",
		async () => {
			const { hops, run } = await raw()
			expect({ ...seen(run, "raw"), hops }, run.stderr).toEqual({
				built: true,
				hops: ["primary GET /hop", "primary GET /echo"],
				out: ['raw 200 /echo Some("application/json")', "body true", "result true 200 true Some(Some(true))"],
			})
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("<Op>Opts carries no transport policy (F6): .header() is the one per-call header path", () => {
	it(
		"refuses a headers field on EchoGetOpts at compile time",
		async () => {
			const run = await consume("http", "headers_field", {
				body: 'n.note("built");',
				decls: "fn headers_field() -> sdk::EchoGetOpts {\n    sdk::EchoGetOpts { headers: Default::default() }\n}",
			})
			expect(
				{
					built: run.built,
					refused: /error\[E0560\]: struct `EchoGetOpts` has no field named `headers`/.test(run.stderr),
				},
				run.stderr,
			).toEqual({ built: false, refused: true })
		},
		CARGO,
	)
})
