/**
 * The Rust target of the conformance grid (R1/G11): every `cellsFor("rust")` cell through the SDK
 * `generateRustSdk` emits from the spawned reference app's served document, compiled once per content
 * hash with the test driver beside it and sent by it, one process per cell, `Observed[]` back. That
 * crate also builds clippy-clean at the pin and checks under the rust 1.85.0 floor toolchain. The safe
 * variant (bit 21 i4, R-i6) sends one cell per response kind through `client.safe()` on the same driver
 * build, which reads each `Answer` strictly, and its compile leg holds every operation's safe call to its
 * normal one and narrows it under cargo. Opt-in: `vitest run --mode harness`.
 */
import { describe, expect, it } from "vitest"
import { type DrivenRustSdk, servedRustSdk } from "../../../src/emit/rust/__fixtures__/driven.ts"
import { RUST_FLOOR, withRust } from "../../../src/emit/rust/__fixtures__/rust-env.ts"
import { rustCallPlans } from "../../../src/emit/rust/sdk.ts"
import type { RustCallPlan } from "../../../src/emit/rust/sdk-plan.ts"
import { originsOf, type ReferenceApp, type TargetRunner, targetSuite } from "./harness.ts"
import { cellsFor, type Observed } from "./matrix.ts"
import { SAFE } from "./safe.ts"

const RUST = withRust()
const FLOOR = withRust(RUST_FLOOR)

/**
 * Each titled cell's v0 port: the suite names its `it` `<key> (<title>)`. The reference request is
 * 3d0dbca04b's live half; its URL vectors are pinned in emit/rust/http.test.ts (path params, the base
 * URL) and its SSE vectors in emit/rust/sse.parse.test.ts.
 */
const V0_PORTS: Readonly<Record<string, string>> = {
	// v0: 3d0dbca04b
	"verbs/reference-request": "v0 3d0dbca04b",
}

/**
 * The Rust runner, in the normal style or the safe one: the SDK and the driver built once from the served
 * document (both runners share the build), and the SDK clippy-clean at the pin (Fe2). A cell the driver cannot
 * express exits non-zero with the reason on stderr, and the runner throws it: the cell is red, never skipped. A
 * cold dependency build runs past the harness hookTimeout, so prepare gets the Rust unit tests' 10 minutes (Fe3).
 */
function rustRunner(variant?: typeof SAFE): TargetRunner {
	let sdk: DrivenRustSdk | undefined
	return {
		async prepare(app) {
			const compiled = servedRustSdk(app.document)
			if (!compiled.built) throw new Error(compiled.stderr)
			const lint = compiled.clippy()
			if (lint.length > 0) throw new Error(lint.join("\n"))
			sdk = compiled
		},
		prepareTimeoutMs: 600_000,
		async run(cell, app) {
			if (sdk === undefined) throw new Error("the Rust runner ran a cell before prepare")
			const ran = await sdk.runCalls(cell, originsOf(app), undefined, variant === SAFE)
			if (ran.status !== 0) throw new Error(`driver exit ${ran.status}: ${ran.stderr}`)
			return ran.observed as readonly Observed[]
		},
		target: "rust",
		titles: variant === undefined ? V0_PORTS : {},
		variant,
	}
}

/** What a safe call is held to: the same connection, or an `Answer` of a stream, of an answer with headers, or of an answer. */
const twinKind = (plan: RustCallPlan) =>
	plan.stream === "ws" || plan.stream === "realtime"
		? "ident"
		: plan.stream === "sse"
			? "stream"
			: plan.responseHeaders === null
				? "value"
				: "headers"

/** One operation's lines: its safe call held to its normal one (the same answer and headers), awaited and narrowed. */
function safeOp(plan: RustCallPlan, i: number): string {
	const at = (client: string) =>
		[client, ...plan.accessors.map((accessor) => `${accessor}()`), `${plan.method}(${args(plan)})`].join(".")
	const kind = twinKind(plan)
	if (kind === "ident")
		return `async fn op${i}(c: &sdk::Client) {\n    let _ = ident(${at("c")}, ${at("c.safe()")});\n}`
	const held = `hold(${at("c")}, ${at("c.safe()")})`
	const body = {
		headers: [`    let _ = narrow(${held}.await);`, `    let _ = narrow(${held}.with_headers().await);`],
		stream: [`    if let Some(mut s) = narrow(${held}.await) {`, "        let _ = s.next().await;", "    }"],
		value: [`    let _ = narrow(${held}.await);`],
	}[kind]
	return [`async fn op${i}(c: &sdk::Client) {`, ...body, "}"].join("\n")
}

/** Each argument of `plan`'s method (its path params, its body, its Opts), each `any()`: only its type matters. */
const args = (plan: RustCallPlan) =>
	Array.from({ length: plan.pathParams.length + (plan.body === null ? 0 : 1) + 1 }, () => "any()").join(", ")

/**
 * The compile leg's program (R-i6 a): for every operation, its `client.safe()` call held to the normal one (`hold`:
 * the same answer `T` and headers `H`, `Throw` against `Safe`), awaited (with its headers too where it declares them)
 * and narrowed by an exhaustive `match` over `Answer` and `SafeError`, each arm's response a `RawResponse`; a
 * connection the very same `Call` on both clients. Never run: building it is the assertion.
 */
function safeProgram(plans: readonly RustCallPlan[]): string {
	return [
		"//! bit 21 i4, R-i6 (a): every operation's safe call, held to its normal one and narrowed.",
		"#![allow(dead_code, unused_variables)]",
		"",
		"/// Any value of the type asked for: the program only builds.",
		"fn any<T>() -> T {",
		'    unimplemented!("never run")',
		"}",
		"",
		"fn ident<T>(_: T, safe: T) -> T {",
		"    safe",
		"}",
		"",
		"fn hold<T, H>(_: sdk::Call<T, sdk::Throw, H>, safe: sdk::Call<T, sdk::Safe, H>) -> sdk::Call<T, sdk::Safe, H> {",
		"    safe",
		"}",
		"",
		"fn narrow<T>(r: Result<sdk::Answer<T>, sdk::Error>) -> Option<T> {",
		"    match r {",
		"        Ok(sdk::Answer::Ok { data, response }) => {",
		"            let _: &sdk::RawResponse = &response;",
		"            Some(data)",
		"        }",
		"        Ok(sdk::Answer::Err { error, response }) => {",
		"            let _: &sdk::RawResponse = &response;",
		"            match error {",
		"                sdk::SafeError::Api(e) => {",
		"                    let _: &sdk::ApiError = &e;",
		"                }",
		"                sdk::SafeError::Decode(e) => {",
		"                    let _: &sdk::DecodeError = &e;",
		"                }",
		"            }",
		"            None",
		"        }",
		"        Err(_) => None,",
		"    }",
		"}",
		"",
		...plans.flatMap((plan, i) => [safeOp(plan, i), ""]),
		"fn main() {",
		`    let _ = (${plans.map((_, i) => `op${i}`).join(", ")});`,
		"}",
		"",
	].join("\n")
}

/** The compile leg (R-i6 a): safeProgram over the served document's SDK, built clean, and not vacuous. */
function compileLeg(app: () => ReferenceApp) {
	describe("conformance × rust (safe): every operation's safe call compiles", () => {
		it("holds each client.safe() call to its normal one, awaits it and narrows its Answer, under cargo", () => {
			const plans = Object.values(rustCallPlans(app().document))
			const kinds = plans.map(twinKind)
			expect({
				calls: plans.length > 20,
				connections: kinds.includes("ident"),
				headers: kinds.includes("headers"),
				streams: kinds.includes("stream"),
			}).toEqual({ calls: true, connections: true, headers: true, streams: true })
			const built = servedRustSdk(app().document, { programs: { safe: safeProgram(plans) } })
			expect(built.built, built.stderr).toBe(true)
		}, 600_000)
	})
}

describe.skipIf(!RUST)("rust toolchain", () => {
	const app = targetSuite(rustRunner())
	targetSuite(rustRunner(SAFE))
	compileLeg(app)

	describe("conformance × rust titles", () => {
		it("titles only cells the grid holds for rust", () => {
			const keys = new Set(cellsFor("rust").map((cell) => cell.key))
			expect(Object.keys(V0_PORTS).filter((key) => !keys.has(key))).toEqual([])
		})
	})

	/*
	 * format.test.ts checks every runtime file under the floor; this leg adds the conformance crate's own
	 * client.rs, resources and types.rs there: error-only methods, binary in and out, form and text bodies,
	 * typed response headers, ws.echo's query. The served document is the one fetched at start, as is.
	 */
	describe("rust 1.85 floor", () => {
		it.skipIf(!FLOOR)(
			"checks the conformance SDK clean under the floor toolchain itself",
			() => {
				const floor = servedRustSdk(app().document, { check: true, toolchain: RUST_FLOOR })
				expect(floor.built, floor.stderr).toBe(true)
			},
			600_000,
		)
	})
})
