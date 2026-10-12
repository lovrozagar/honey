import { describe, expect, it } from "vitest"
import { generateOpenApi } from "../../../src/codegen.ts"
import { defineErrors } from "../../../src/errors.ts"
import { honey } from "../../../src/index.ts"
import { mergeTree, overlaySchemas, type RouteTree } from "../../../src/tree.ts"

/*
 * A gateway serves its downstream routes from the merged tree and documents them. A route's error
 * keys belong to its own app's error factory: a key the gateway's factory does not know must still
 * be documented under the status the downstream app gives it.
 */

const INFO = { title: "gateway", version: "1" }

type Responses = Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }>

function errorKeys(spec: Record<string, unknown>, path: string, method: string, status: string): string[] {
	const paths = spec["paths"] as Record<string, Record<string, { responses: Responses }>>
	const schema = paths[path]?.[method]?.responses[status]?.content?.["application/json"]?.schema ?? {}
	const ref = schema["$ref"]
	const components = (spec["components"] as { schemas: Record<string, Record<string, unknown>> }).schemas
	const resolved = typeof ref === "string" ? (components[ref.split("/").pop() ?? ""] ?? {}) : schema
	const props = resolved["properties"] as { error_key?: { enum?: string[] } } | undefined
	return props?.error_key?.enum ?? []
}

describe("gateway OpenAPI", () => {
	it("documents a downstream route's own error keys beside the gateway's", async () => {
		const down = honey()
			.errorFactory(
				defineErrors({
					column_name_taken: "conflict",
					internal_server_error: "internal_server_error",
					optimistic_lock_conflict: "conflict",
				}),
			)
			.defaultBoundary("internal_server_error")
		down
			.post("/columns")
			.errors("column_name_taken", "optimistic_lock_conflict")
			.handler((c) => c.res.json("ok", {}))
		const source = mergeTree([down.toRouteTree(), { worker: "down" }]) as RouteTree

		const gateway = (tree?: RouteTree) => {
			const app = honey()
				.errorFactory(
					defineErrors({
						captcha_failed: "bad_request",
						internal_server_error: "internal_server_error",
						optimistic_lock_conflict: "conflict",
					}),
				)
				.defaultBoundary("internal_server_error")
				.defaultErrors("captcha_failed")
			if (tree !== undefined) app.routeTree(tree)
			app.all("/*").handler((c) => c.res.json("ok", {}))
			return app
		}
		const served = (gateway() as unknown as { _gatewayTree(t: RouteTree): RouteTree })._gatewayTree(source)
		const app = gateway(served)
		overlaySchemas(app as never, source)
		const spec = (await generateOpenApi(app as never, { info: INFO })) as unknown as Record<string, unknown>

		expect(errorKeys(spec, "/columns", "post", "409")).toEqual(["column_name_taken", "optimistic_lock_conflict"])
		expect(errorKeys(spec, "/columns", "post", "400")).toEqual(["captcha_failed"])
	})
})
