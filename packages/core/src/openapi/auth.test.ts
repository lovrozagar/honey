import { describe, expect, it } from "vitest"
import { defineErrors } from "../errors/errors.ts"
import { honey } from "../routing/app.ts"
import { SILENT } from "../telemetry/logger.ts"
import { basic, credentialsMatch, type ServedAuth } from "./auth.ts"
import { scalar } from "./scalar.ts"
import { serveOpenApi } from "./serve.ts"
import { serveStaticOpenApi } from "./static.ts"
import { swagger } from "./swagger.ts"

type Env = { readonly PASSWORD: string }
type App = { fetch(request: Request, env: object): Promise<Response> | Response }

const ENV: Env = { PASSWORD: "s3cret:with-colon" }
const DOC = { info: { title: "Prebuilt", version: "2.0.0" }, openapi: "3.1.0", paths: {} }
const DOCS = { "/docs/scalar": scalar, "/docs/swagger": swagger }
const PATHS = ["/openapi.json", "/openapi.yaml", "/openapi.yml", "/docs/scalar", "/docs/swagger"]
const CHALLENGE = 'Basic realm="Internal API", charset="UTF-8"'

/** `text` as base64 of its UTF-8 bytes, as a browser sends a Basic credential. */
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const basicOf = (pair: string) => `Basic ${base64(new TextEncoder().encode(pair))}`

const docsOnly = basic({
	realm: "Internal API",
	verify: ({ env, password, username }: { env: Env; password: string; username: string }) =>
		credentialsMatch({ password, username }, { password: env.PASSWORD, username: "docs" }),
})

/** Each serving function, mounting the document, its YAML and both pages behind `auth`. */
const SERVING: Record<string, (app: App, auth?: ServedAuth) => App> = {
	serveOpenApi: (app, auth) => serveOpenApi(app, { auth, docs: DOCS, title: "T", version: "1" }),
	serveStaticOpenApi: (app, auth) =>
		serveStaticOpenApi(app, {
			auth,
			docs: DOCS,
			json: { inline: DOC },
			yaml: { inline: 'openapi: "3.1.0"\n' },
		}),
}

const plain = () => honey<Env>().logger(SILENT)

const errors = defineErrors({ oops: "internal_server_error" })

/** An app as it comes, one whose errors a formatter shapes behind a default boundary, and one whose onError answers. */
const APPS: Record<string, () => App> = {
	plain,
	formatted: () =>
		honey<Env>()
			.logger(SILENT)
			.errorFactory(errors)
			.defaultBoundary("oops")
			.defaultErrorFormatter((error) => ({ code: error.errorKey })),
	replaced: () =>
		honey<Env>()
			.logger(SILENT)
			.onError(() => new Response("nope", { status: 401 })),
}

/** What a refused request's body says on each app: honey's envelope, the formatter's shape, the onError answer. */
const REFUSED_BODY: Record<string, unknown> = {
	formatted: { code: "unauthorized" },
	plain: expect.objectContaining({ error_key: "unauthorized", status: 401, success: false }),
	replaced: "nope",
}

const get = (app: App, path: string, headers: Record<string, string> = {}) =>
	app.fetch(new Request(`http://x${path}`, { headers }), ENV)

const bodyOf = async (res: Response) => {
	const text = await res.text()
	return res.headers.get("content-type")?.includes("json") ? (JSON.parse(text) as unknown) : text
}

const REFUSED: Record<string, Record<string, string>> = {
	"no Authorization": {},
	"a Bearer token": { authorization: "Bearer abc" },
	"base64 that is not": { authorization: "Basic !!!" },
	"bytes that are not UTF-8": { authorization: `Basic ${base64(new Uint8Array([0xff, 0xfe, 0x3a, 0x78]))}` },
	"no colon": { authorization: basicOf("docs") },
	"a wrong password": { authorization: basicOf("docs:wrong") },
	"a wrong username": { authorization: `${basicOf(`admin:${ENV.PASSWORD}`)}` },
}

describe.each(Object.keys(SERVING))("%s behind basic()", (serving) => {
	const serve = SERVING[serving] as (typeof SERVING)[string]

	it.each(Object.keys(APPS))(
		"answers %s app's refused requests 401, with the challenge and no-store, on every route",
		async (kind) => {
			const app = serve((APPS[kind] as () => App)(), docsOnly)
			for (const [why, headers] of Object.entries(REFUSED)) {
				for (const path of PATHS) {
					const res = await get(app, path, headers)
					expect(
						[res.status, res.headers.get("www-authenticate"), res.headers.get("cache-control"), await bodyOf(res)],
						`${why} at ${path}`,
					).toEqual([401, CHALLENGE, "no-store", REFUSED_BODY[kind]])
				}
			}
		},
	)

	it("answers the right credentials 200 on every route, private and no-store, with no validator to revalidate", async () => {
		const app = serve(plain(), docsOnly)
		const authorization = basicOf(`docs:${ENV.PASSWORD}`)
		for (const path of PATHS) {
			const res = await get(app, path, { authorization, "if-none-match": "*" })
			expect(
				[res.status, res.headers.get("cache-control"), res.headers.get("etag"), res.headers.get("www-authenticate")],
				path,
			).toEqual([200, "private, no-store", null, null])
		}
	})
})

describe.each(Object.keys(SERVING))("%s calling verify", (serving) => {
	const serve = SERVING[serving] as (typeof SERVING)[string]

	it("hands verify the env and the decoded pair, a non-ASCII username and a password holding a colon", async () => {
		const seen: unknown[] = []
		const auth = basic({
			realm: "R",
			verify: (input) => {
				seen.push(input)
				return Promise.resolve(true)
			},
		})
		const app = serve(plain(), auth)
		const res = await get(app, "/openapi.json", { authorization: basicOf("jürgen:p:ss wörd") })
		expect([res.status, seen]).toEqual([200, [{ env: ENV, password: "p:ss wörd", username: "jürgen" }]])
	})

	it("answers a verify that throws 500, a fault and never a refusal", async () => {
		const auth = basic({
			realm: "R",
			verify: () => {
				throw new Error("the key store is down")
			},
		})
		const res = await get(serve(plain(), auth), "/openapi.json", {
			authorization: basicOf("docs:x"),
		})
		expect([res.status, res.headers.get("www-authenticate")]).toEqual([500, null])
	})

	it("answers without auth as it always has: a public validator and a 304 for it", async () => {
		const app = serve(plain())
		const res = await get(app, "/openapi.json")
		const tag = res.headers.get("etag") ?? ""
		const hit = await get(app, "/openapi.json", { "if-none-match": tag })
		expect([res.status, res.headers.get("cache-control"), /^"[\w-]{22}"$/.test(tag), hit.status]).toEqual([
			200,
			"no-cache",
			true,
			304,
		])
	})
})

describe("credentialsMatch and basic()", () => {
	it("matches only when both the username and the password match", async () => {
		const expected = { password: "pw", username: "docs" }
		expect(
			await Promise.all([
				credentialsMatch({ password: "pw", username: "docs" }, expected),
				credentialsMatch({ password: "pw", username: "doc" }, expected),
				credentialsMatch({ password: "px", username: "docs" }, expected),
				credentialsMatch({ password: "", username: "" }, expected),
			]),
		).toEqual([true, false, false, false])
	})

	it("refuses a realm the challenge cannot quote: a quote, a control character, or nothing", () => {
		for (const realm of ['say "hi"', "line\nbreak", ""])
			expect(() => basic({ realm, verify: () => true }), JSON.stringify(realm)).toThrow(
				`basic: realm ${JSON.stringify(realm)} must be text with no quote or control character`,
			)
	})

	it("refuses auth beside a cacheControl, whose public cache would hand the guarded document to anyone", () => {
		expect(() =>
			// @ts-expect-error cacheControl: a guarded document is never cached in public
			serveStaticOpenApi(honey<Env>(), {
				auth: docsOnly,
				cacheControl: "public, max-age=60",
				json: { inline: DOC },
			}),
		).toThrow(new TypeError("serveStaticOpenApi: auth answers private, no-store; leave cacheControl out beside it"))
	})
})
