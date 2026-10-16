/**
 * The Rust SDK's safe mode (contract 19 §5.6, Fc5), split from errors.test.ts at the 500 cap: an error status lands
 * in `SdkResult.error` with its kind, status, key and response, and every other failure is the call's `Err`. Driven
 * through the `http-safe` and `fixtures-safe` drivers.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { RustError, Trace } from "../shared/__fixtures__/protocol.ts"
import { type Reply, recordingServer, served } from "../shared/__fixtures__/recording-server.ts"
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

/** `calls` run by `sdk` against a server answering `replies`: the run. */
function drive(sdk: DrivenRustSdk, replies: readonly Reply[], calls: readonly Call[]) {
	return served(replies, async (server) => ({ run: await sdk.runCalls({ calls, setup: {} }, server, {}) }))
}

/** `calls` against an origin that refuses every connection. */
async function refused(sdk: DrivenRustSdk, calls: readonly Call[]) {
	const closed = await recordingServer([])
	await closed.close()
	return sdk.runCalls({ calls, setup: {} }, { url: closed.url }, {})
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
			observed: [[failed(404)], [null]],
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
