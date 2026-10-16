/**
 * The Rust half of gen's adversarial suite (bit 13; split from emit-adversarial.test.ts at the 500 cap): the
 * shared adversarial corpus's SDK built and clippy-clean in both throwOnError modes, every hostile name a Rust
 * identifier and every value a literal, and checked under the floor toolchain; then the emitted Rust runtime's
 * three guards answered on the wire, on the `http` fixture's driven SDK (the one `http*.test.ts` builds): a
 * cross-origin redirect hop stripped, a path param escaped or refused, and every on_log entry and error text
 * free of path values, the query and the token. The gen mutation harness reruns this directory with each guard
 * disabled, so a mutant's runtime is what compiles here.
 */
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { DrivenRustSdk } from "../../src/emit/rust/__fixtures__/driven.ts"
import type { Script } from "../../src/emit/shared/__fixtures__/protocol.ts"
import { RUST_FLOOR, withRust } from "../../src/emit/rust/__fixtures__/rust-env.ts"
import { type Reply, served } from "../../src/emit/shared/__fixtures__/recording-server.ts"
import type { Call, Setup } from "../integration/conformance/matrix.ts"
import { guardNamed } from "../structure/mutation-harness.guards.ts"

/** Whether Rust is here, and the floor toolchain: a missing one fails where it is required and skips elsewhere (rust-env). */
const RUST = withRust()
const FLOOR = withRust(RUST_FLOOR)

const REPO = resolve(import.meta.dirname, "../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolve(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock: compiled.ts and driven.ts reach sdk.ts and so http.ts, so a mutant's runtime is what compiles */
const { compiledRust } = (await import(
	resolve(REPO, "packages/gen/src/emit/rust/__fixtures__/compiled.ts")
)) as typeof import("../../src/emit/rust/__fixtures__/compiled.ts")
const { drivenRustSdk } = (await import(
	resolve(REPO, "packages/gen/src/emit/rust/__fixtures__/driven.ts")
)) as typeof import("../../src/emit/rust/__fixtures__/driven.ts")

describe.skipIf(!RUST)("gen adversarial: the Rust SDK emitter", () => {
	/* v0 ran cargo check and skipped offline; v1 emits the lock and builds --locked --offline (G9/G10), and the corpus is clippy-gated (Ff4) */
	// v0: 60586125be
	// v0: 0e7f1d78fc
	// v0: 2678a4695b
	// v0: 923fa8ab43
	it("builds clippy-clean in both throwOnError modes, every hostile name a Rust identifier and every value a literal", () => {
		const modes = (["adversarial", "adversarial-safe"] as const).map((key) => {
			const crate = compiledRust(key)
			return { built: crate.built, clippy: crate.clippy(), key, stderr: crate.stderr }
		})
		expect(
			[
				modes.map(({ built, clippy, key }) => ({ built, clippy, key })),
				({} as Record<string, unknown>).polluted,
				({} as Record<string, unknown>).y,
			],
			modes.map((mode) => mode.stderr).join(""),
		).toEqual([
			[
				{ built: true, clippy: [], key: "adversarial" },
				{ built: true, clippy: [], key: "adversarial-safe" },
			],
			undefined,
			undefined,
		])
	}, 600_000)

	it.skipIf(!FLOOR)(
		"checks the corpus SDK clean under the floor toolchain itself",
		() => {
			const floor = compiledRust("adversarial", { check: true, toolchain: RUST_FLOOR })
			expect(floor.built, floor.stderr).toBe(true)
		},
		600_000,
	)
})

/** The `http` SDK with the driver, compiled once per suite run (the mutant's runtime included): it must build. */
let guardSdk: DrivenRustSdk | undefined
function guards(): DrivenRustSdk {
	guardSdk ??= drivenRustSdk("http")
	expect(guardSdk.built, guardSdk.stderr).toBe(true)
	return guardSdk
}

const BEARER: Setup["auth"] = { kind: "bearer", token: "s3cret" }
const HOP: Call = { operation: "hop.get", route: { method: "GET", path: "/hop" } }
/* a 307 to the other origin, then the landing */
const AWAY: Reply[] = [
	{ redirect: { origin: "alt", path: "/landing" }, status: 307 },
	{ json: {}, status: 200 },
]
/* the auth header, a cookie and a configured header, a redirect followed */
const CARRIED: Setup = { auth: BEARER, headers: { Cookie: "sid=1", "X-Api-Key": "k-1" }, redirect: "follow" }
/* a path param value, a query value and (by the setup) a token, on a success and then a 401 */
const MEMBER: Call = {
	operation: "members.get",
	params: { org: "p4th", "user-id": "u-1" },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
	search: { ids: ["k3y"] },
}
const usersGet = (id: string): Call => ({
	operation: "users.get",
	params: { id },
	route: { method: "GET", path: "/users/{id}" },
})

/** HOP sent with CARRIED through AWAY under `script`: the driver's status, where it landed and the credentials it landed with. */
async function landing(sdk: DrivenRustSdk, script?: Script): Promise<{ seen: unknown[]; stderr: string }> {
	const { hops, run } = await served(AWAY, async (server) => ({
		hops: server.hops,
		run: await sdk.runCalls({ calls: [HOP], setup: CARRIED }, server, script),
	}))
	const hop = hops[1]
	const credentials = ["authorization", "cookie", "x-api-key"].map((name) => hop?.headers[name] ?? null)
	return { seen: [run.status, `${hop?.origin} ${hop?.url}`, credentials], stderr: run.stderr }
}

describe.skipIf(!RUST)("gen adversarial: the emitted Rust runtime", () => {
	it("drops the auth header, cookies and configured headers on a cross-origin redirect hop, a caller's http_builder included", async () => {
		const sdk = guards()
		const runs = await Promise.all([landing(sdk), landing(sdk, { config: { httpClient: true } })])
		expect(
			runs.map((r) => r.seen),
			runs.map((r) => r.stderr).join(""),
		).toEqual([
			[0, "alt /landing", [null, null, null]],
			[0, "alt /landing", [null, null, null]],
		])
	}, 600_000)

	it("never lets a path param add, drop or climb a segment", async () => {
		const sdk = guards()
		const { hops, run } = await served([], async (server) => {
			const cell = { calls: [usersGet("../admin"), usersGet("a/b"), usersGet("..")] }
			return { hops: server.hops, run: await sdk.runCalls(cell, { url: `${server.url}/v1` }, {}) }
		})
		expect(
			{ errors: run.trace?.calls.map((c) => c.error?.variant ?? null), urls: hops.map((h) => h.url) },
			run.stderr,
		).toEqual({ errors: [null, null, "PathParam"], urls: ["/v1/users/..%2Fadmin", "/v1/users/a%2Fb"] })
	}, 600_000)

	it("keeps path values, the query and the token out of every on_log entry and error text", async () => {
		const sdk = guards()
		const replies: Reply[] = [
			{ json: { id: "m-1", name: "n" }, status: 200 },
			{ json: { message: "no access" }, status: 401 },
		]
		const run = await served(replies, (server) =>
			sdk.runCalls({ calls: [MEMBER, MEMBER], setup: { auth: BEARER } }, server, { log: true }),
		)
		const log = run.trace?.log ?? []
		/* the error record carries its text and Debug, so a value in either is seen */
		const seen = JSON.stringify([log, run.trace?.calls.map((c) => c.error)])
		/* events and status keep it from passing vacuously: an empty log or a missing 401 fails it clean */
		expect(
			{
				events: log.map((e) => e.event),
				leaks: ["s3cret", "k3y", "p4th"].filter((word) => seen.includes(word)),
				status: run.trace?.calls[1]?.error?.status,
			},
			run.stderr,
		).toEqual({
			events: ["request_start", "response_received", "request_start", "response_received", "error"],
			leaks: [],
			status: 401,
		})
	}, 600_000)
})
