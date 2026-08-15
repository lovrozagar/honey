/**
 * Type-level tests for ctx.meta typing.
 * Run with: bunx tsc --noEmit
 * These use explicit type annotations that fail tsc if types are wrong.
 */

import { describe, it } from "vitest"
import { honey } from "../../../src/index.ts"

type AppMeta = { auth: string; worker: string }

describe("ctx.meta type from .meta<T>()", () => {
	it("catch-all handler inherits app-level meta type", () => {
		honey<{}>()
			.meta<AppMeta>()
			.all("*")
			.handler((ctx) => {
				const auth: string = ctx.meta.auth
				const worker: string = ctx.meta.worker
				return ctx.res.text("ok", `${auth}${worker}`)
			})
	})

	it("proxy destination inherits app-level meta type", () => {
		honey<{}>()
			.meta<AppMeta>()
			.all("*")
			.proxy({
				destination: (ctx) => {
					const worker: string = ctx.meta.worker
					return new Response(worker)
				},
			})
	})

	it("named route with .meta() has typed meta", () => {
		honey<{}>()
			.meta<AppMeta>()
			.get("/test")
			.meta({ auth: "jwt", worker: "extract" })
			.handler((ctx) => {
				const auth: string = ctx.meta.auth
				return ctx.res.text("ok", auth)
			})
	})
})
