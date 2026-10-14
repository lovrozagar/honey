/**
 * The error answer's envelope through the app: what the default shape carries (fields, status,
 * status_key, message) and keeps off (vars, cause); defaultErrorFormatter extending, replacing or
 * reading vars, framework 404 and 405 answers formatted too; the custom formatter only for errors
 * with data, both formatters carried under a basePath; a thrown error's headers kept, through a
 * formatter as well, never leaked when a boundary wraps it; and which key answers under a factory.
 */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { HoneyError } from "../../src/errors/error.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import { type Honey, honey } from "../../src/routing/app.ts"

type App = Honey<{}>

async function send(app: { fetch: App["fetch"] }, path: string, init?: RequestInit) {
	const res = await app.fetch(new Request(`http://localhost${path}`, init), {})
	return {
		body: (await res.json()) as Record<string, unknown>,
		headers: Object.fromEntries(res.headers),
		status: res.status,
	}
}

/** An app whose GET /t throws `thrown()`, configured by `configure` first. */
function throwing(thrown: () => unknown, configure: (app: App) => void = () => undefined): App {
	const app = honey<{}>().logger(false)
	configure(app)
	app.get("/t").handler(() => {
		throw thrown()
	})
	return app
}

const rateLimited = () =>
	new HoneyError({ errorKey: "rate_limited", status: "too_many_requests", vars: { limit: 100, retryAfter: 60 } })
const fields = { email: [{ error_key: "field_invalid_email", message: "bad", path: "json.email" }] }

describe("the default envelope", () => {
	// v0: 10325f2700
	// v0: eb247b0495
	// v0: c8efda6f89
	// v0: 5f38aaf701
	// v0: 85d57d8458
	it("carries key, message, status, status_key and fields; never vars or the cause", async () => {
		const withFields = throwing(
			() =>
				new HoneyError({ cause: new Error("secret"), errorKey: "val_error", fields, status: "unprocessable_entity" }),
		)
		expect(await send(withFields, "/t")).toEqual({
			body: {
				error_key: "val_error",
				fields,
				message: "val_error",
				status: 422,
				status_key: "unprocessable_entity",
				success: false,
			},
			headers: { "content-type": "application/json" },
			status: 422,
		})
		const { body } = await send(throwing(rateLimited), "/t")
		expect([body.error_key, body.message, "vars" in body, "cause" in body]).toEqual([
			"rate_limited",
			"rate_limited",
			false,
			false,
		])
	})
})

/** A defaultErrorFormatter adding the key in capitals to the shape it is handed. */
const extend = (app: App) =>
	app.defaultErrorFormatter((error, shape) => ({ ...shape, code: error.errorKey.toUpperCase() }))

describe("defaultErrorFormatter", () => {
	// v0: ce3abcf241
	// v0: ea456bc9ed
	// v0: 61ef6e1d5d
	// v0: c0729c2f30
	// v0: adf963fb44
	// v0: 338ebee911
	it("extends the default shape it is handed, for a HoneyError and for an unknown throw's 500", async () => {
		const known = await send(
			throwing(() => new HoneyError({ errorKey: "bad_request", status: "bad_request" }), extend),
			"/t",
		)
		const unknown = await send(
			throwing(() => new Error("boom"), extend),
			"/t",
		)
		expect([known.status, known.body.code, known.body.success, known.body.error_key]).toEqual([
			400,
			"BAD_REQUEST",
			false,
			"bad_request",
		])
		expect([unknown.status, unknown.body.code, unknown.body.error_key]).toEqual([
			500,
			"INTERNAL_SERVER_ERROR",
			"internal_server_error",
		])
	})

	// v0: 9d454f37b1
	// v0: b68007f377
	// v0: d4dc8ac02d
	// v0: 348fd83a5f
	it("replaces the shape outright, reads vars off the error, and is never handed the cause", async () => {
		const shapes: object[] = []
		const app = throwing(rateLimited, (a) =>
			a.defaultErrorFormatter((error, shape) => {
				shapes.push(shape)
				return { code: shape.error_key, ok: false, retryAfter: error.vars?.retryAfter }
			}),
		)
		expect(await send(app, "/t")).toMatchObject({
			body: { code: "rate_limited", ok: false, retryAfter: 60 },
			status: 429,
		})
		expect((await send(app, "/t")).body).toEqual({ code: "rate_limited", ok: false, retryAfter: 60 })
		expect(shapes.map((shape) => ["cause" in shape, "vars" in shape])).toEqual([
			[false, false],
			[false, false],
		])
	})
})

const appErrors = defineErrors({
	api_error: "internal_server_error",
	email_taken: "conflict",
	item_not_found: {
		schema: { "~standard": { validate: (value: unknown) => ({ value }), vendor: "t", version: 1 as const } },
		status: "not_found",
	},
})

/** /std throws a standard error and /custom one with data, both formatters set, under `base`. */
function bothFormatters(base = "") {
	const app = honey<{}>()
		.errorFactory(appErrors)
		.defaultBoundary("api_error")
		.defaultErrorFormatter((_e, shape) => ({ ...shape, source: "default" }))
		.customErrorFormatter((_e, data) => ({ ...(data as object), source: "custom" }))
	const scope = base === "" ? app : app.basePath(base)
	scope
		.get("/std")
		.errors("email_taken")
		.handler(() => {
			throw appErrors.email_taken()
		})
	scope
		.get("/custom")
		.errors("item_not_found")
		.handler(() => {
			throw appErrors.item_not_found({ reason: "gone" } as never)
		})
	return app
}

describe("the custom formatter beside the default one", () => {
	// v0: ed46d78425
	// v0: f785615d07
	// v0: 519100299c
	// v0: 6b7c4dfa58
	// v0: dd6a4d692f
	it.each(["", "/api"])("under basePath %j, each formatter shapes only its own kind of error", async (base) => {
		const app = bothFormatters(base)
		expect([await send(app, `${base}/std`), await send(app, `${base}/custom`)]).toMatchObject([
			{ body: { error_key: "email_taken", source: "default", success: false }, status: 409 },
			{ body: { reason: "gone", source: "custom" }, status: 404 },
		])
		expect(Object.keys((await send(app, `${base}/custom`)).body).sort()).toEqual(["reason", "source"])
	})
})

/** A factory with zod-typed errors beside standard ones, as an app declares it. */
const zodErrors = defineErrors({
	api_error: "internal_server_error",
	item_not_found: { schema: z.object({ reason: z.string() }), status: "not_found" },
	validation_error: "unprocessable_entity",
})

const zodBase = () => honey<{}>().errorFactory(zodErrors).defaultBoundary("api_error").logger(false)

/** /declared throws item_not_found declared, /undeclared undeclared, /std a standard error. */
function zodApp(configure: (app: ReturnType<typeof zodBase>) => void = () => undefined) {
	const app = zodBase()
	configure(app)
	app
		.get("/declared")
		.errors("item_not_found")
		.handler(() => {
			throw zodErrors.item_not_found({ reason: "intact" })
		})
	app.get("/undeclared").handler(() => {
		throw zodErrors.item_not_found({ reason: "should be wrapped" })
	})
	app
		.get("/std")
		.errors("validation_error")
		.handler(() => {
			throw zodErrors.validation_error()
		})
	return app
}

describe("an error typed by a zod schema", () => {
	// v0: 3b7581bcf1
	// v0: c658a45d66
	// v0: 71298c781b
	// v0: 5bb206bd23
	// v0: 582400f945
	it("answers its payload when declared; a boundary wraps it, payload gone, when not; a standard one the envelope", async () => {
		const app = zodApp()
		const [declared, undeclared, standard] = [
			await send(app, "/declared"),
			await send(app, "/undeclared"),
			await send(app, "/std"),
		]
		expect([
			declared.status,
			declared.body,
			undeclared.status,
			undeclared.body.error_key,
			"reason" in undeclared.body,
		]).toEqual([404, { reason: "intact" }, 500, "api_error", false])
		expect([standard.status, standard.body.error_key, standard.body.success]).toEqual([422, "validation_error", false])
	})

	// v0: 1527976bfb
	// v0: a62e463a99
	// v0: 13fb6e63b4
	it("the custom formatter post-processes its payload, schema overload too; the default formatter never touches it", async () => {
		const custom = zodApp((a) => a.customErrorFormatter((_e, data) => ({ ...(data as object), request_id: "req-123" })))
		const overload = zodApp((a) =>
			a.customErrorFormatter(z.object({ trace_id: z.string() }), (_e, data) => ({
				...(data as object),
				trace_id: "trace-abc",
			})),
		)
		const plain = zodApp((a) => a.defaultErrorFormatter((_e, shape) => ({ ...shape, wrapped: true })))
		expect([
			(await send(custom, "/declared")).body,
			(await send(overload, "/declared")).body,
			(await send(plain, "/declared")).body,
		]).toEqual([
			{ reason: "intact", request_id: "req-123" },
			{ reason: "intact", trace_id: "trace-abc" },
			{ reason: "intact" },
		])
	})
})

describe("a thrown error's headers", () => {
	// v0: b77a4d65f5
	// v0: 53f419c322
	// v0: 8ef2fee64c
	it("are answered beside the content type, through a formatter too, and nothing else is added", async () => {
		const errors = defineErrors({ broken: "internal_server_error", rate_limited: "too_many_requests" })
		const app = honey<{}>().errorFactory(errors).logger(false)
		const formatted = honey<{}>()
			.errorFactory(errors)
			.defaultErrorFormatter((_e, shape) => ({ ...shape, custom: true }))
		for (const target of [app, formatted])
			target
				.get("/limited")
				.errors("rate_limited")
				.handler(() => {
					throw errors.rate_limited({ headers: { "retry-after": "30" } })
				})
		app
			.get("/broken")
			.errors("broken")
			.handler(() => {
				throw errors.broken()
			})
		const [plain, shaped, broken] = [
			await send(app, "/limited"),
			await send(formatted, "/limited"),
			await send(app, "/broken"),
		]
		expect([plain.status, plain.headers, shaped.headers, shaped.body.custom, broken.headers]).toEqual([
			429,
			{ "content-type": "application/json", "retry-after": "30" },
			{ "content-type": "application/json", "retry-after": "30" },
			true,
			{ "content-type": "application/json" },
		])
	})

	// v0: 02be275750
	it("never reach the client when a boundary wraps the error that carried them", async () => {
		const errors = defineErrors({ internal_server_error: "internal_server_error", secret_err: "bad_request" })
		const app = honey<{}>().errorFactory(errors).defaultBoundary("internal_server_error").logger(false)
		app.get("/leak").handler(() => {
			throw errors.secret_err({ headers: { "x-debug": "leaked" } })
		})
		const res = await send(app, "/leak")
		expect([res.status, res.body.error_key, res.headers]).toEqual([
			500,
			"internal_server_error",
			{ "content-type": "application/json" },
		])
	})
})

const keyed = defineErrors({
	auth_failed: "unauthorized",
	boundary: "internal_server_error",
	not_found: "not_found",
	org_slug_taken: "conflict",
	rate_limited: "too_many_requests",
	teapot: "im_a_teapot",
	["e".repeat(1000)]: "bad_request",
})
const other = defineErrors({ special_error: "bad_request" })

/** How a route under the `keyed` factory, with auth_failed a default error, declares its errors. */
type Declares = "defaults only" | "nothing, no defaults" | "not_found" | "org_slug_taken" | "other's special_error"

function keyedApp(declares: Declares, thrown: () => unknown) {
	const app = honey<{}>().errorFactory(keyed).logger(false)
	if (declares !== "nothing, no defaults") app.defaultErrors("auth_failed")
	const route = app.get("/t")
	const handler = () => {
		throw thrown()
	}
	if (declares === "not_found" || declares === "org_slug_taken") route.errors(declares).handler(handler)
	else if (declares === "other's special_error") route.errors(other, "special_error").handler(handler)
	else route.handler(handler)
	return app
}

/** A thrown error, the route it is thrown on, and the status and key that answer it. */
const ANSWERS: Array<{ declares: Declares; key: string; label: string; status: number; thrown: () => unknown }> = [
	{ declares: "not_found", key: "not_found", label: "a declared key", status: 404, thrown: () => keyed.not_found() },
	{
		declares: "not_found",
		key: "auth_failed",
		label: "a default key",
		status: 401,
		thrown: () => keyed.auth_failed(),
	},
	{
		declares: "other's special_error",
		key: "special_error",
		label: "another factory's declared key",
		status: 400,
		thrown: () => other.special_error(),
	},
	{
		declares: "not_found",
		key: "internal_server_error",
		label: "an undeclared key",
		status: 500,
		thrown: () => keyed.rate_limited(),
	},
	{
		declares: "other's special_error",
		key: "internal_server_error",
		label: "a HoneyError from no factory",
		status: 500,
		thrown: () => new HoneyError({ errorKey: "not_declared", status: "conflict" }),
	},
	{
		declares: "nothing, no defaults",
		key: "rate_limited",
		label: "any key, on an open route",
		status: 429,
		thrown: () => keyed.rate_limited(),
	},
	{
		declares: "org_slug_taken",
		key: "not_found",
		label: "a framework key the route did not declare",
		status: 404,
		thrown: () => keyed.not_found(),
	},
	{
		declares: "nothing, no defaults",
		key: "teapot",
		label: "a key on a rare status",
		status: 418,
		thrown: () => keyed.teapot(),
	},
	{
		declares: "nothing, no defaults",
		key: "e".repeat(1000),
		label: "a 1000-character key",
		status: 400,
		thrown: () => keyed["e".repeat(1000)]!(),
	},
]

describe("which key answers under a factory", () => {
	// v0: 3fa7557754
	// v0: 52a63249b6
	// v0: f959b7805b
	// v0: c214e8f0eb
	// v0: 598234625f
	// v0: 1d2d5d544a
	// v0: 0b062506d4
	// v0: 80728b3143
	// v0: 9bb6a0537a
	// v0: 3652dfc398
	// v0: e2c80e56bf
	// v0: 1449edb496
	// v0: cb4bcd22aa
	// v0: 57ad378d1b
	// v0: 7c78996b15
	// v0: 8b98ac8284
	// v0: 4b5a4488a0
	// v0: 075c2fd500
	it.each(ANSWERS)("$label, on a route declaring $declares", async ({ declares, key, status, thrown }) => {
		const res = await send(keyedApp(declares, thrown), "/t")
		expect([res.status, res.body.error_key]).toEqual([status, key])
	})

	// v0: 80e05b9d18
	it("an empty factory leaves an app serving", async () => {
		const app = honey<{}>().errorFactory(defineErrors({}))
		app.get("/t").handler((ctx) => ctx.res.json("ok", { up: true }))
		expect(await send(app, "/t")).toMatchObject({ body: { up: true }, status: 200 })
	})
})

describe("a boundary over a factory", () => {
	// v0: 21d399096d
	// v0: 2c5356715b
	// v0: adad409fbe
	// v0: 3f223dff25
	it.each(["app", "route"] as const)("the %s boundary lets a declared key through and wraps the rest", async (at) => {
		const app = honey<{}>().errorFactory(keyed).logger(false)
		if (at === "app") app.defaultBoundary("boundary")
		const declared = (path: string) => {
			const route = app.get(path).errors("not_found")
			return at === "route" ? route.boundary("boundary") : route
		}
		declared("/declared").handler(() => {
			throw keyed.not_found()
		})
		declared("/undeclared").handler(() => {
			throw keyed.org_slug_taken()
		})
		declared("/plain").handler(() => {
			throw new Error("unexpected")
		})
		const answers = await Promise.all(["/declared", "/undeclared", "/plain"].map((path) => send(app, path)))
		expect(answers.map((answer) => [answer.status, answer.body.error_key])).toEqual([
			[404, "not_found"],
			[500, "boundary"],
			[500, "boundary"],
		])
	})

	// v0: 20887ffc8d
	it("onError still sees the error the boundary wrapped", async () => {
		const seen: unknown[] = []
		const app = honey<{}>().errorFactory(keyed).logger(false)
		app.onError((error) => {
			seen.push(error)
			return undefined
		})
		app
			.get("/me")
			.boundary("boundary")
			.handler(() => {
				throw new Error("original boom")
			})
		const res = await send(app, "/me")
		expect([res.body.error_key, seen.map((error) => (error as Error).message)]).toEqual(["boundary", ["original boom"]])
	})
})
