/**
 * The Rust SDK's safe mirror (contract 19 §5.6, Fc5; bit 21 i4), split from errors.test.ts at the 500 cap: on
 * `client.safe()` an answer is `Ok(Answer::Err { error, response })` (an error status, declared or not, as
 * `SafeError::Api` with its kind, status, key and response; an undecodable 2xx or one past the cap as
 * `SafeError::Decode`), and only a failure without an answer is the call's `Err` (f2). Driven through the `http`
 * and `fixtures` drivers in the safe style; the driver reads each `Answer` strictly (observe.rs `Settles`). Moved
 * here from sdk.calls.test.ts at the 500 cap: the two styles of one crate, and the removed safe mode's pattern
 * refused at compile time (R-i4), each a consumer program.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { RustError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, REFUSED_URL, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, sections, seen } from "./__fixtures__/consumer.ts"
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
function driven(key: "fixtures" | "http"): DrivenRustSdk {
	const sdk = drivenRustSdk(key)
	expect(sdk.built, sdk.stderr).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run on `client.safe()` of `sdk` under `options` against a server answering `replies`. */
function drive(sdk: DrivenRustSdk, replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: options.setup ?? {} }, server, options.script ?? {}, true)
		return { hops: server.hops.length, run }
	})
}

/** `calls` on `client.safe()` against an origin that refuses every connection. */
async function refused(sdk: DrivenRustSdk, calls: readonly Call[]) {
	return sdk.runCalls({ calls, setup: {} }, { url: REFUSED_URL }, {}, true)
}

type Traced = Trace<RustError>["calls"][number]
/** An error status as the driver observes it, for a `{"message": "m"}` body. */
const failed = (status: number) => ({ body: { message: "m" }, errorKey: null, kind: "error", status })
const answer = (status: number): Reply => ({ json: { message: "m" }, status })
/** A safe call's `Answer::Err`, its response its answer's. */
const missed = (status: number) => ({ data: false, ok: false, response: true, status })

/** Where a safe call's failure landed: its route ("result" for an `Answer::Err`), variant, kind, status and key, and its `Answer`. */
const landed = (call: Traced | undefined) => {
	const e = call?.error
	return [e?.via, e?.variant, e?.kind, e?.status, e?.keyVariant, call?.result]
}

describe.skipIf(!RUST)(
	"client.safe(): an answer an Answer::Err with its response, only no answer the call's Err",
	() => {
		// v0: fd4f5e61be
		// v0: 9f28089ca4
		it("answers a 404 and an undeclared 418 (the base ApiError) as Answer::Err, a refused connection the call's Err", async () => {
			const sdk = driven("http")
			const { run } = await drive(sdk, [answer(404), answer(418)], [MEMBERS, MEMBERS])
			const lost = await refused(sdk, [MEMBERS])
			const [found, teapot, gone] = [...(run.trace?.calls ?? []), ...(lost.trace?.calls ?? [])].map(landed)
			expect({ found, gone, observed: [run.observed, lost.observed], teapot }, run.stderr + lost.stderr).toEqual({
				found: ["result", "Api", "NotFound", 404, "None", missed(404)],
				gone: ["return", "Transport", undefined, undefined, undefined, undefined],
				observed: [[failed(404), failed(418)], [{ kind: "transport" }]],
				teapot: ["result", "Api", "Other", 418, "None", missed(418)],
			})
		}, 600_000)

		/* R-i1 and the i1 carry-in: an undecodable 2xx and one past the cap are answers; a timeout, a cancel and a hook throw are none (f2) */
		it("answers an undecodable or over-cap 2xx as Answer::Err(Decode), and keeps a timeout, a cancel and a hook throw the call's Err", async () => {
			const sdk = driven("http")
			const torn: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
			const late: Reply = { delayMs: 2000, json: { id: "u", name: "n" }, status: 200 }
			const calls = [USER, { ...MEMBERS, timeoutMs: 300 }, MEMBERS]
			const script: Script = { calls: [null, null, { cancel: "before" }] }
			const { hops, run } = await drive(sdk, [torn, late], calls, { script })
			const big: Reply = { json: { id: "u", name: "a name past the cap" }, status: 200 }
			const capped = await drive(sdk, [big], [USER], { setup: { maxResponseBytes: 16 } })
			const hooked = await drive(sdk, [], [MEMBERS], { script: { hooks: { request: [{ fail: "boom" }] } } })
			const traces = [run, capped.run, hooked.run].flatMap((r) => r.trace?.calls ?? [])
			expect(
				{
					hops: [hops, capped.hops, hooked.hops],
					landed: traces.map(landed),
					observed: [run.observed, capped.run.observed, hooked.run.observed],
				},
				run.stderr + capped.run.stderr + hooked.run.stderr,
			).toEqual({
				hops: [2, 1, 0],
				landed: [
					["result", "Decode", undefined, undefined, undefined, missed(200)],
					["return", "Timeout", undefined, undefined, undefined, undefined],
					["return", "Canceled", undefined, undefined, undefined, undefined],
					["result", "Decode", undefined, undefined, undefined, missed(200)],
					["return", "Hook", undefined, undefined, undefined, undefined],
				],
				observed: [
					[{ kind: "decode", status: 200 }, { kind: "timeout" }, null],
					[{ kind: "decode", status: 200 }],
					[null],
				],
			})
		}, 600_000)
	},
)

describe.skipIf(!RUST)("client.safe(): each Answer its own", () => {
	/* the grid runs one process per cell: two Ok answers on one client prove each holds its own data and response */
	it("holds each Answer::Ok's own data and response across calls on one client", async () => {
		const one: Reply = { json: { id: "1" }, status: 200 }
		const two: Reply = { json: { id: "2" }, status: 201 }
		const { run } = await drive(driven("http"), [one, two], [USER, USER])
		expect({ observed: run.observed, results: run.trace?.calls.map((c) => c.result) }, run.stderr).toEqual({
			observed: [
				{ data: { id: "1" }, kind: "data", status: 200 },
				{ data: { id: "2" }, kind: "data", status: 201 },
			],
			results: [
				{ data: true, ok: true, response: true, status: 200 },
				{ data: true, ok: true, response: true, status: 201 },
			],
		})
	}, 600_000)

	// v0: 099f5c479f
	it("reads an envelope-declared key in a safe-mode result: error-keys users.create 400 as EmailTaken", async () => {
		/* mode: v0 ran safe mode only; the throw-mode leg is the errors consumer's `keys` (ItemMissing from a $ref envelope) */
		const route = { method: "POST", path: "/error-keys/users" }
		const create: Call = { ...CREATE, operation: "error-keys.users.create", route }
		const { run } = await drive(driven("fixtures"), [{ json: TAKEN, status: 400 }], [create])
		expect({ landed: landed(run.trace?.calls[0]), observed: run.observed }, run.stderr).toEqual({
			landed: ["result", "Api", "BadRequest", 400, "Some(EmailTaken)", missed(400)],
			observed: [{ body: TAKEN, errorKey: "email_taken", kind: "error", status: 400 }],
		})
	}, 600_000)
})

/** A hop as one line: method, path, the JSON body when sent. */
const wire = (hop: RecordedHop) =>
	[hop.method, hop.url, ...(hop.body.json === undefined ? [] : [JSON.stringify(hop.body.json)])].join(" ")

/** Two error-keys users.create calls on `on` (the client, or `c.safe()`), each `r` typed `result`, shown by `show`. */
const createTwice = (on: string, result: string, show: string) => `    let c = client(base)?;
    for _ in 0..2 {
        let body = serde_json::from_value(serde_json::json!({ "email": "a@x.test" })).expect("body");
        let r: ${result} = ${on}.error_keys().users().create(&body, &Default::default()).await;
        ${show}
    }`

const ENVELOPE = {
	error_key: "email_taken",
	fields: {},
	message: "taken",
	status: 400,
	status_key: "bad_request",
	success: false,
}

/** The merged `fixtures` document's crate, with `fns` run once against the recording server as the `name` program. */
const errorKeys = (name: string, fns: Readonly<Record<string, string>>) =>
	served(
		[
			{ json: ENVELOPE, status: 400 },
			{ json: { email: "a@x.test", id: "u1" }, status: 201 },
		],
		async (server) => {
			const run = await consume("fixtures", name, { base: server.url, ...sections(fns) })
			return { hops: server.hops.map(wire), run }
		},
	)

describe.skipIf(!RUST)("the two styles, one crate (bit 21 i4)", () => {
	// v0: 2c4d54394e
	it("resolves Result<T, Error> on the client, an error status as Error::Api; Result<Answer<T>, Error> on client.safe()", async () => {
		const thrown = await errorKeys("thrown", {
			main: createTwice(
				"c",
				"Result<sdk::ErrorKeysUser, sdk::Error>",
				`match r {
            Ok(user) => n.note(format!("ok {}", user.id)),
            Err(sdk::Error::Api(e)) => n.note(format!("api {}", e.status())),
            Err(e) => return Err(e),
        }`,
			),
		})
		const safe = await errorKeys("safe", {
			main: createTwice(
				"c.safe()",
				"Result<sdk::Answer<sdk::ErrorKeysUser>, sdk::Error>",
				`match r? {
            sdk::Answer::Err { error: sdk::SafeError::Api(e), response } => n.note(format!("error {} {}", e.status(), response.status)),
            sdk::Answer::Err { error, .. } => n.note(format!("other {error:?}")),
            sdk::Answer::Ok { data, response } => n.note(format!("data {} {}", serde_json::to_string(&data).expect("data"), response.status)),
        }`,
			),
		})
		const create = 'POST /error-keys/users {"email":"a@x.test"}'
		const sent = [create, create]
		expect(
			{ safe: { ...seen(safe.run), wire: safe.hops }, thrown: { ...seen(thrown.run), wire: thrown.hops } },
			thrown.run.stderr + safe.run.stderr,
		).toEqual({
			safe: { built: true, out: ["error 400 400", 'data {"email":"a@x.test","id":"u1"} 201'], wire: sent },
			thrown: { built: true, out: ["api 400", "ok u1"], wire: sent },
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the removed safe mode (bit 21 i4, R-i4)", () => {
	/* the removed safe mode's pattern fails to compile, never silently compiles to something else */
	it("refuses the removed safe mode's pattern: SdkResult, its error, status and is_ok, on either client", async () => {
		const old = await consume("fixtures", "removed", {
			base: "http://127.0.0.1:9",
			...sections({
				main: `    let c = client(base)?;
    let body: sdk::ErrorKeysUsersCreateBody = serde_json::from_value(serde_json::json!({ "email": "a@x.test" })).expect("body");
    let _: Option<sdk::SdkResult<sdk::ErrorKeysUser>> = None;
    let r = c.safe().error_keys().users().create(&body, &Default::default()).await?;
    n.note(format!("{} {}", r.is_ok(), r.status));
    let u = c.error_keys().users().create(&body, &Default::default()).await?;
    n.note(format!("{:?}", u.error));`,
			}),
		})
		const found = (text: string) => old.stderr.includes(text)
		expect(
			{
				built: old.built,
				error: found("no field `error` on type `ErrorKeysUser`"),
				isOk: found("no method named `is_ok` found for enum `Answer<T, E>`"),
				sdkResult: found("cannot find type `SdkResult` in crate `sdk`"),
				status: found("no field `status` on type `Answer<ErrorKeysUser>`"),
			},
			old.stderr,
		).toEqual({ built: false, error: true, isOk: true, sdkResult: true, status: true })
	}, 600_000)
})
