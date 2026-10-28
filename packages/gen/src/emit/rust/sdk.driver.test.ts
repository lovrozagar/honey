/**
 * The Rust compile fixture and test driver (contract 18 §7, Fb5/Fb6/Fb8): a registry crate compiles once per
 * content hash and a second compile spawns no cargo; programs build as bins in a copy of the crate, so the
 * shipped crate stays as emitted; the floor and clippy options; the driver's `dispatch.rs` written from the
 * call plans, no reflection; and the driver and a consumer program run against the recording server.
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import { compiledRust } from "./__fixtures__/compiled.ts"
import { drivenRustSdk } from "./__fixtures__/driven.ts"
import { consume, sections, seen } from "./__fixtures__/consumer.ts"
import { dispatchRs } from "./__fixtures__/dispatch.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { RUST_FLOOR, withRust } from "./__fixtures__/rust-env.ts"
import { served } from "../shared/__fixtures__/recording-server.ts"
import type { RustCallPlan } from "./sdk-plan.ts"
import { rustCallPlans } from "./sdk.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()
const FLOOR = withRust(RUST_FLOOR)

const OP = "orgs.members.notes.create"

/** The NOTES op's plan, in the emitter's names: two path params in path order, a query and a header param, a JSON body. */
const NOTES: RustCallPlan = {
	accessors: ["orgs", "members", "notes"],
	body: "json",
	headers: { "X-Trace": "x_trace" },
	idempotencyKey: null,
	method: "create",
	operation: OP,
	opts: "OrgsMembersNotesCreateOpts",
	pathParams: ["org", "member"],
	query: { tag: "tag" },
	required: [],
	response: "json",
	responseHeaders: null,
	stream: null,
}

/** NOTES's plan with `over` in place. */
const plan = (over: Partial<RustCallPlan>): RustCallPlan => ({ ...NOTES, ...over })

/** NOTES's arm in a throw-mode dispatch.rs. */
const NOTES_ARM = [
	`        "${OP}" => {`,
	"            let mut o = sdk::OrgsMembersNotesCreateOpts::default();",
	'            if let Some(v) = call.search("tag") { o.tag = Some(from(v)?); }',
	'            if let Some(v) = call.header_param("X-Trace") { o.x_trace = Some(from(v)?); }',
	'            let c = client.orgs().members().notes().create(&call.param("org")?, &call.param("member")?, &call.json_body()?, &o);',
	"            observe(apply(c, call, input, d)).await",
	"        }",
].join("\n")

/** A program over the dependency-free `cache` crate: its `one()` and the stdin it was given. */
const PROBE =
	'use std::io::Read;\n\nfn main() {\n    let mut s = String::new();\n    std::io::stdin().read_to_string(&mut s).unwrap();\n    print!("{} {}", cache_probe::one(), s.trim());\n}\n'

/** A two-file program over the same crate. */
const PAIR = {
	"main.rs": 'mod two;\n\nfn main() {\n    print!("{}", two::two() + cache_probe::one());\n}\n',
	"two.rs": "pub fn two() -> u8 {\n    2\n}\n",
}

/** Every file under `dir`, relative, sorted. */
const filesUnder = (dir: string) =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
		.sort()

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("dispatchRs: the driver's dispatch.rs, one match arm per call plan", () => {
	it("calls an op through its accessors, each Opts field set from the call, path params, body and opts in signature order", () => {
		expect(dispatchRs({ [OP]: NOTES })).toContain(`${NOTES_ARM}\n`)
	})

	it("sets a required field bare, observes a safe-mode answer, a stream as in throw mode, and refuses a multipart body for good", () => {
		const text = dispatchRs(
			{
				a: plan({ operation: "a", query: { format: "format" }, required: ["format"] }),
				b: plan({ operation: "b", stream: "sse" }),
				e: plan({ body: "multipart", operation: "e" }),
			},
			false,
		)
		expect(text).toContain('if let Some(v) = call.search("format") { o.format = from(v)?; }')
		expect(text).toContain("observe_safe(apply(c, call, input, d)).await")
		expect(text).not.toContain(" observe(")
		expect(text).toContain("crate::stream::observe_events(apply(c, call, input, d), call.take).await")
		expect(text).not.toContain("refused(")
		expect(text).toContain('"e" => Err("a multipart body is driven by a consumer program (FilePart)".into()),')
	})

	it("passes a binary body by value, one-shot when the script asks, and calls a binary answer like any other", () => {
		const text = dispatchRs({
			c: plan({ body: "binary", operation: "c", pathParams: [] }),
			d: plan({ body: null, operation: "d", response: "binary" }),
		})
		expect(text).toContain("let c = client.orgs().members().notes().create(call.binary_body(d.one_shot_body)?, &o);")
		expect(text).toContain('        "d" => {')
		expect(text).not.toContain("refused(")
	})

	it("sets the idempotency key the script gives, and reads typed response headers through the real FromHeaders", () => {
		const text = dispatchRs({
			[OP]: plan({
				idempotencyKey: "idempotency_key",
				responseHeaders: {
					fields: { "X-Etag": "x_etag", "X-Item-Version": "x_item_version" },
					type: "ItemsGetHeaders",
				},
			}),
		})
		expect(text).toContain("            if let Some(k) = &d.idempotency_key { o.idempotency_key = Some(k.clone()); }\n")
		expect(text).toContain(
			[
				"            fn read(h: &reqwest::header::HeaderMap) -> Result<BTreeMap<String, String>, sdk::Error> {",
				"                let v = <sdk::ItemsGetHeaders as sdk::FromHeaders>::from_headers(h)?;",
				"                let mut m = BTreeMap::new();",
				'                put(&mut m, "x-etag", &v.x_etag);',
				'                put(&mut m, "x-item-version", &v.x_item_version);',
				"                Ok(m)",
				"            }",
				"            observe(apply(c, call, input, d).reading(read)).await",
			].join("\n"),
		)
		expect(dispatchRs({ [OP]: NOTES })).not.toContain("idempotency_key")
	})
})

describe.skipIf(!RUST)("the compile cache: one compile per content hash, a shared target dir", () => {
	it(
		"builds a registry crate once: a second compile reads its marker and spawns no cargo",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const first = compiledRust("cache")
			expect({ built: first.built, complete: existsSync(join(first.dir, ".complete")) }, first.stderr).toEqual({
				built: true,
				complete: true,
			})
			/* no cargo to find: a second compile that spawned one could not build */
			vi.stubEnv("PATH", "")
			const second = compiledRust("cache")
			expect({ built: second.built, dir: second.dir, fresh: second.fresh }).toEqual({
				built: true,
				dir: first.dir,
				fresh: false,
			})
		},
	)

	it(
		"builds programs as bins in a copy of the crate, runs them on stdin, and keeps the shipped crate as emitted",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const crate = compiledRust("cache", { programs: { pair: PAIR, probe: PROBE } })
			expect(crate.built, crate.stderr).toBe(true)
			expect(await crate.exec("probe", "hi\n")).toEqual({ status: 0, stderr: "", stdout: "1 hi" })
			expect(await crate.exec("pair", "")).toEqual({ status: 0, stderr: "", stdout: "3" })
			await expect(crate.exec("nope", "")).rejects.toThrow("no program nope")
			const markers = [".clippy", ".complete"]
			expect(filesUnder(crate.dir).filter((file) => !markers.includes(file))).toEqual(
				Object.keys(FIXTURES.cache.files).sort(),
			)
			vi.stubEnv("PATH", "")
			const again = compiledRust("cache", { programs: { pair: PAIR, probe: PROBE } })
			expect({ built: again.built, fresh: again.fresh }).toEqual({ built: true, fresh: false })
			expect(await again.exec("probe", "again")).toEqual({ status: 0, stderr: "", stdout: "1 again" })
		},
	)

	it(
		"runs a program that never reads its stdin, however large the input, its exit status the answer",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const crate = compiledRust("cache", { programs: { pair: PAIR, probe: PROBE } })
			/* more than a pipe holds: the program exits before the write ends, which must not surface as EPIPE */
			expect(await crate.exec("pair", "x".repeat(4 << 20))).toEqual({ status: 0, stderr: "", stdout: "3" })
		},
	)
})

describe.skipIf(!RUST)("the compile options: clippy, and the floor toolchain", () => {
	it(
		"reports clippy's findings under -D clippy::incompatible_msrv, kept once per crate",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			expect(compiledRust("cache").clippy()).toEqual([])
			const canary = compiledRust("canary")
			expect(canary.built, canary.stderr).toBe(true)
			const findings = canary.clippy()
			/* short format names no lint: incompatible_msrv says what the floor lacks */
			expect(
				findings.some((line) => /: error: current MSRV .* is `1\.85\.0`/.test(line)),
				findings.join("\n"),
			).toBe(true)
			vi.stubEnv("PATH", "")
			expect(compiledRust("canary").clippy()).toEqual(findings)
		},
	)

	it.skipIf(!FLOOR)(
		"checks under the floor toolchain in a crate dir of its own: 1.85.0 rejects what is stable later",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const floor = compiledRust("canary", { check: true, toolchain: RUST_FLOOR })
			expect({ built: floor.built, rejected: floor.stderr.includes("E0658") }, floor.stderr).toEqual({
				built: false,
				rejected: true,
			})
			const cache = compiledRust("cache", { check: true, toolchain: RUST_FLOOR })
			expect(cache.built, cache.stderr).toBe(true)
			expect(new Set([floor.dir, cache.dir, compiledRust("canary").dir, compiledRust("cache").dir]).size).toBe(4)
		},
	)
})

describe("rustCallPlans: each operation's call plan, in the emitter's own names", () => {
	it("names the accessors, the method, the path params in signature order and every Opts field", () => {
		expect(rustCallPlans(FIXTURES.surface.document(), FIXTURES.surface.options)[OP]).toEqual(NOTES)
	})
})

describe("sections: each section an async fn of its own, named from the section", () => {
	it("names a section's fn with its `-` as `_`, and refuses a name that is then no Rust identifier", () => {
		expect(sections({ "cancel-safe": "", main: "" }).decls).toContain(
			"async fn cancel_safe_section(n: &mut Notes, base: &str)",
		)
		for (const name of ["two words", "1st", "", "é"])
			expect(() => sections({ [name]: "" }), name).toThrow(
				`a section name must be a Rust identifier once its "-" are "_": ${JSON.stringify(name)}`,
			)
	})
})

/** The create call the smoke sends: path params needing escapes, a query, the header param, a JSON body. */
const CREATE: Call = {
	body: { kind: "json", value: { tags: ["a"], text: "hi" } },
	headers: { "x-trace": "t-1" },
	operation: OP,
	params: { member: "m?1", org: "a/b c" },
	route: { method: "POST", path: "/orgs/{org}/members/{member}/notes" },
	search: { tag: "x&y z" },
}

describe.skipIf(!RUST)("the Rust test driver and a consumer program, against the recording server", () => {
	it("sends a nested POST by its call plan and observes the data", async () => {
		const sdk = drivenRustSdk("surface")
		expect(sdk.built, sdk.stderr).toBe(true)
		const setup = { auth: { kind: "bearer", token: "tok" } } as const
		const [run, hops] = await served([{ json: { id: "n1", text: "hi" }, status: 200 }], async (server) => [
			await sdk.runCalls({ calls: [CREATE], setup }, server),
			server.hops,
		])
		expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({
			observed: [{ data: { id: "n1", text: "hi" }, kind: "data", status: 200 }] satisfies Observed[],
			status: 0,
		})
		expect(hops).toMatchObject([
			{
				body: { contentType: "application/json", json: { tags: ["a"], text: "hi" } },
				headers: { authorization: "Bearer tok", "x-trace": "t-1" },
				method: "POST",
				url: "/orgs/a%2Fb%20c/members/m%3F1/notes?tag=x%26y+z",
			},
		])
	}, 600_000)

	it("builds a consumer program with its opt-in imports and prints its notes", async () => {
		const run = await consume("surface", "exports", {
			body: 'let _: fn(ClientConfig) -> Result<Client, Error> = Client::new;\n    n.note("ok");',
			imports: ["sdk::{Client, ClientConfig, Error}"],
		})
		expect(seen(run), run.stderr).toEqual({ built: true, out: ["ok"] })
	}, 600_000)
})
