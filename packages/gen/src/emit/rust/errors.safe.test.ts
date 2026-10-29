/**
 * The Rust SDK's safe mode (contract 19 §5.6, Fc5), split from errors.test.ts at the 500 cap: an error status lands
 * in `SdkResult.error` with its kind, status, key and response, and every other failure is the call's `Err`. Driven
 * through the `http-safe` and `fixtures-safe` drivers.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { RustError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { REFUSED_URL, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

const EMAIL: Call["body"] = { kind: "json", value: { email: "a@x.test" } }
const CREATE: Call = { body: EMAIL, operation: "users.create", route: { method: "POST", path: "/users" } }
const MEMBERS: Call = {
	operation: "members.get",
	params: { org: "o", "user-id": "u" },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
}
const USER: Call = { operation: "users.get", params: { id: "1" }, route: { method: "GET", path: "/users/{id}" } }

/** error-keys.json's 400 envelope (`fields` set), with `success` the one member ErrorEnvelope keeps in `extra`. */
const TAKEN = {
	error_key: "email_taken",
	fields: { email: [{ error_key: "taken", message: "is taken", path: "email" }] },
	message: "taken",
	status: 400,
	status_key: "bad_request",
	success: false,
}

/** The registry SDK `key` compiled with the driver, which must compile (a cached one spawns no cargo). */
function driven(key: "fixtures-safe" | "http-safe"): DrivenRustSdk {
	const sdk = drivenRustSdk(key)
	expect(sdk.built, sdk.stderr).toBe(true)
	return sdk
}

/** `calls` run by `sdk` under `script` against a server answering `replies`: the run and the hops. */
function drive(sdk: DrivenRustSdk, replies: readonly Reply[], calls: readonly Call[], script: Script = {}) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: {} }, server, script)
		return { hops: server.hops.length, run }
	})
}

/** `calls` against an origin that refuses every connection. */
async function refused(sdk: DrivenRustSdk, calls: readonly Call[]) {
	return sdk.runCalls({ calls, setup: {} }, { url: REFUSED_URL }, {})
}

type Traced = Trace<RustError>["calls"][number]
/** An error status as the driver observes it, for a `{"message": "m"}` body. */
const failed = (status: number) => ({ body: { message: "m" }, errorKey: null, kind: "error", status })
const answer = (status: number): Reply => ({ json: { message: "m" }, status })
/** A safe-mode result holding an error status. */
const missed = (status: number) => ({ data: false, ok: false, response: true, status })

/** Where a safe-mode call's failure landed: its route, variant, kind, status and key, and its result. */
const landed = (call: Traced | undefined) => {
	const e = call?.error
	return [e?.via, e?.variant, e?.kind, e?.status, e?.keyVariant, call?.result]
}

describe.skipIf(!RUST)("safe mode: an error status in SdkResult.error, every other failure the call's Err", () => {
	// v0: fd4f5e61be
	// v0: 9f28089ca4
	it("puts a 404 in the result beside its status and response, and a refused connection in the Err", async () => {
		const sdk = driven("http-safe")
		const { run } = await drive(sdk, [answer(404)], [MEMBERS])
		const lost = await refused(sdk, [MEMBERS])
		const [found, gone] = [landed(run.trace?.calls[0]), landed(lost.trace?.calls[0])]
		expect({ found, gone, observed: [run.observed, lost.observed] }, run.stderr + lost.stderr).toEqual({
			found: ["result", "Api", "NotFound", 404, "None", missed(404)],
			gone: ["return", "Transport", undefined, undefined, undefined, undefined],
			observed: [[failed(404)], [{ kind: "transport" }]],
		})
	}, 600_000)

	/* ported from csharp/errors.safe.test.ts:78: every other failure is the call's Err, never a result */
	it("keeps an undecodable 2xx, a timeout, a cancel and a hook throw out of the result, each the call's Err", async () => {
		const sdk = driven("http-safe")
		const torn: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
		const late: Reply = { delayMs: 2000, json: { id: "u", name: "n" }, status: 200 }
		const calls = [USER, { ...MEMBERS, timeoutMs: 300 }, MEMBERS]
		const script: Script = { calls: [null, null, { cancel: "before" }] }
		const { hops, run } = await drive(sdk, [torn, late], calls, script)
		const hooked = await drive(sdk, [], [MEMBERS], { hooks: { request: [{ fail: "boom" }] } })
		const traces = [run, hooked.run].flatMap((r) => r.trace?.calls ?? [])
		expect(
			{ hops: [hops, hooked.hops], landed: traces.map(landed), observed: [run.observed, hooked.run.observed] },
			run.stderr + hooked.run.stderr,
		).toEqual({
			hops: [2, 0],
			landed: [
				["return", "Decode", undefined, undefined, undefined, undefined],
				["return", "Timeout", undefined, undefined, undefined, undefined],
				["return", "Canceled", undefined, undefined, undefined, undefined],
				["return", "Hook", undefined, undefined, undefined, undefined],
			],
			observed: [[{ kind: "decode", status: 200 }, { kind: "timeout" }, null], [null]],
		})
	}, 600_000)

	// v0: 099f5c479f
	it("reads an envelope-declared key in a safe-mode result: error-keys users.create 400 as EmailTaken", async () => {
		/* mode: v0 ran safe mode only; the throw-mode leg is the errors consumer's `keys` (ItemMissing from a $ref envelope) */
		const route = { method: "POST", path: "/error-keys/users" }
		const create: Call = { ...CREATE, operation: "error-keys.users.create", route }
		const { run } = await drive(driven("fixtures-safe"), [{ json: TAKEN, status: 400 }], [create])
		expect({ landed: landed(run.trace?.calls[0]), observed: run.observed }, run.stderr).toEqual({
			landed: ["result", "Api", "BadRequest", 400, "Some(EmailTaken)", missed(400)],
			observed: [{ body: TAKEN, errorKey: "email_taken", kind: "error", status: 400 }],
		})
	}, 600_000)
})
