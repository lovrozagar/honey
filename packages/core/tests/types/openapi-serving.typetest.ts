/** What serving a document takes at compile time: the docs map, and auth only where no public cache can hold it. */
import { expectTypeOf, test } from "vitest"
import { honey } from "../../src/routing/app.ts"
import { basic } from "../../src/openapi/auth.ts"
import { scalar } from "../../src/openapi/scalar.ts"
import { type ServeOpenApiOptions, serveOpenApi } from "../../src/openapi/serve.ts"
import { serveStaticOpenApi } from "../../src/openapi/static.ts"
import { swagger } from "../../src/openapi/swagger.ts"

const auth = basic({ realm: "Internal", verify: ({ password }) => password === "pw" })
const json = { inline: {} }

test("docs maps each path to its page, never a page alone", () => {
	expectTypeOf(scalar).toExtend<NonNullable<ServeOpenApiOptions["docs"]>[string]>()
	serveOpenApi(honey<{}>(), { docs: { "/scalar": scalar, "/swagger": swagger }, title: "T", version: "1" })
	serveStaticOpenApi(honey<{}>(), { docs: { "/docs": scalar }, json })
	// @ts-expect-error a page without its path
	serveOpenApi(honey<{}>(), { docs: scalar, title: "T", version: "1" })
	// @ts-expect-error a page without its path
	serveStaticOpenApi(honey<{}>(), { docs: swagger, json })
	// @ts-expect-error docsPath is gone: the path is the map's key
	serveStaticOpenApi(honey<{}>(), { docs: { "/docs": scalar }, docsPath: "/reference", json })
})

test("auth comes from basic() alone, and never beside a cacheControl", () => {
	expectTypeOf(auth).toEqualTypeOf<NonNullable<ServeOpenApiOptions["auth"]>>()
	serveOpenApi(honey<{}>(), { auth, title: "T", version: "1" })
	serveStaticOpenApi(honey<{}>(), { auth, json })
	serveStaticOpenApi(honey<{}>(), { cacheControl: "public, max-age=60", json })
	// @ts-expect-error cacheControl: a guarded document is never cached in public
	serveStaticOpenApi(honey<{}>(), { auth, cacheControl: "public, max-age=60", json })
	// @ts-expect-error a hand-built guard
	serveStaticOpenApi(honey<{}>(), { auth: { realm: "R" }, json })
})
