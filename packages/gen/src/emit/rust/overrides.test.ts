/**
 * Per-call overrides on the owning `Call` a method returns (contract 19 §5.7; G2/G3): `.header()` over the
 * client's `headers` for that call alone, `.timeout()` in place of the client's (zero: none), `.base_url()` to
 * another origin, and the raw response, read through `.with_response()` beside the answer and kept by an
 * error status's `ApiError`. Driven in both styles on `http` (the client and `client.safe()`, bit 21 i4); the raw
 * response's URL after a redirect and the Opts without a `headers` field are consumer programs.
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

/* both styles: a per-call override applies whatever the method's client answers */
const MODES = [
	["throw", false],
	["safe", true],
] as const

/** The `http` SDK compiled with the driver, which must build. */
function driven(): DrivenRustSdk {
	const sdk = drivenRustSdk("http")
	expect(sdk.built, sdk.stderr).toBe(true)
	return sdk
}

/** `calls` run by the driver on one client (`client.safe()` when `safe`) under `setup` against a server answering `replies`. */
async function drive(safe: boolean, replies: readonly Reply[], calls: readonly Call[], setup: Setup = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, server, undefined, safe)
		return { hops: [...server.hops], run }
	})
}

describe.skipIf(!RUST)("a per-call header (.header) over the client's headers", () => {
	// v0: fc7a1a3d78
	it.each(MODES)(
		"wins over the config's same name for that call only, every other config header inherited (%s)",
		async (_, safe) => {
			const setup: Setup = { headers: { "X-Keep": "k", "X-Trace": "d" } }
			const calls = [{ ...ECHO, headers: { "x-trace": "a" } }, ECHO]
			const { hops, run } = await drive(safe, [OK, OK], calls, setup)
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
		async (_, safe) => {
			const slow: Reply = { ...OK, delayMs: 2000 }
			const { hops, run } = await drive(safe, [slow], [{ ...ECHO, timeoutMs: 300 }], { timeoutMs: 10_000 })
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
		async (_, safe) => {
			const slow: Reply = { ...OK, delayMs: 1000 }
			const calls = [{ ...ECHO, timeoutMs: 0 }, ECHO]
			const { hops, run } = await drive(safe, [slow, slow], calls, { timeoutMs: 300 })
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
		async (_, safe) => {
			const { hops, run } = await drive(safe, [OK, OK], [{ ...ECHO, origin: "alt" }, ECHO])
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
		async (_, safe) => {
			const reply: Reply = { headers: { "x-total": "3" }, json: { id: "i1", name: "n" }, status: 200 }
			const { hops, run } = await drive(safe, [reply], [{ ...ITEM, raw: true }])
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
		async (_, safe) => {
			const reply: Reply = { headers: { "x-total": "0" }, json: { message: "gone" }, status: 404 }
			const { run } = await drive(safe, [reply], [{ ...ITEM, raw: true }])
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

/** A safe consumer reading `hop.get`'s raw response after a same-origin 302 to `/echo`, on `client.safe()`. */
const RAW = sections({
	raw: `    let c = client(base)?;
    match c.safe().hop().get(&sdk::HopGetOpts::default()).with_response().await? {
        sdk::Answer::Ok { data: (d, raw), response } => {
            let _: (&sdk::HopGetResponse, &sdk::RawResponse) = (&d, &raw);
            let kind = raw.headers.get("content-type").and_then(|v| v.to_str().ok());
            n.note(format!("raw {} {} {kind:?}", raw.status, raw.url.path()));
            n.note(format!("body {}", raw.body == br#"{"ok":true}"#.as_slice()));
            n.note(format!("answer ok {} {} {:?}", response.status, response.url == raw.url, Some(d.ok)));
        }
        other => n.note(format!("unexpected {other:?}")),
    }`,
})

/** The `raw` program run once against a 302 to `/echo` and its answer, with the hops it sent. */
const raw = once(() =>
	served([{ redirect: { origin: "primary", path: "/echo" }, status: 302 }, OK], async (server) => {
		const run = await consume("http", "raw", { ...RAW, base: server.url })
		return { hops: server.hops.map((h) => `${h.origin} ${h.method} ${h.url}`), run }
	}),
)

describe.skipIf(!RUST)("RawResponse: the answer's status, headers, body and the URL it came from", () => {
	// v0: 7db7423d4c
	it(
		"is the last hop's after a redirect, and client.safe()'s Answer::Ok holds the same response",
		async () => {
			const { hops, run } = await raw()
			expect({ ...seen(run, "raw"), hops }, run.stderr).toEqual({
				built: true,
				hops: ["primary GET /hop", "primary GET /echo"],
				out: ['raw 200 /echo Some("application/json")', "body true", "answer ok 200 true Some(Some(true))"],
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
