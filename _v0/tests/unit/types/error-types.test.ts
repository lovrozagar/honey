import { describe, expectTypeOf, it } from "vitest"
import type { HoneyError } from "../../../src/error.ts"
import { defineErrors, honey } from "../../../src/index.ts"
import type { InferErrorFactory, InferRouteErrors } from "../../../src/types.ts"

const errs = defineErrors({
	email_taken: "conflict",
	not_allowed: "forbidden",
	org_limit: "forbidden",
})

describe("defineErrors return type", () => {
	it("returns typed factory with keys matching input map", () => {
		expectTypeOf(errs.email_taken).toBeFunction()
		expectTypeOf(errs.org_limit).toBeFunction()
		expectTypeOf(errs.not_allowed).toBeFunction()
	})

	it("factory functions return HoneyError", () => {
		const err = errs.email_taken()
		expectTypeOf(err).toEqualTypeOf<HoneyError>()
	})
})

describe("InferErrorFactory", () => {
	it("extracts factory type from app with .errorFactory()", () => {
		const app = honey<{}>().errorFactory(errs)
		type Factory = InferErrorFactory<typeof app>
		expectTypeOf<Factory>().toMatchTypeOf<{
			email_taken: () => HoneyError
			not_allowed: () => HoneyError
			org_limit: () => HoneyError
		}>()
	})

	it("returns never without .errorFactory()", () => {
		const app = honey<{}>()
		type Factory = InferErrorFactory<typeof app>
		expectTypeOf<Factory>().toBeNever()
	})
})

describe("InferRouteErrors", () => {
	it("extracts error keys from route with .errors(factory, keys)", () => {
		const app = honey<{}>()
			.get("/test")
			.errors(errs, "email_taken", "org_limit")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		type Errors = InferRouteErrors<typeof app, "/test", "get">
		expectTypeOf<Errors>().toEqualTypeOf<"email_taken" | "org_limit">()
	})

	it("returns never for route without .errors()", () => {
		const app = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		type Errors = InferRouteErrors<typeof app, "/health", "get">
		expectTypeOf<Errors>().toBeNever()
	})

	it(".defaultErrors propagates to all subsequent routes", () => {
		const app = honey<{}>()
			.errorFactory(errs)
			.defaultErrors("not_allowed")
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.get("/b")
			.errors("email_taken")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		type ErrorsA = InferRouteErrors<typeof app, "/a", "get">
		expectTypeOf<"not_allowed">().toMatchTypeOf<ErrorsA>()

		type ErrorsB = InferRouteErrors<typeof app, "/b", "get">
		expectTypeOf<"not_allowed">().toMatchTypeOf<ErrorsB>()
		expectTypeOf<"email_taken">().toMatchTypeOf<ErrorsB>()
	})
})

describe("handler ctx.errors typing", () => {
	it("ctx.errors has only declared keys from .errors()", () => {
		honey<{}>()
			.get("/test")
			.errors(errs, "email_taken")
			.handler((ctx) => {
				expectTypeOf(ctx.errors.email_taken).toBeFunction()
				return ctx.res.text("ok", "ok")
			})
	})

	it("errorFactory + .errors(keys) — ctx.errors scoped to keys + defaults", () => {
		honey<{}>()
			.errorFactory(errs)
			.defaultErrors("not_allowed")
			.get("/test")
			.errors("email_taken")
			.handler((ctx) => {
				expectTypeOf(ctx.errors.email_taken).toBeFunction()
				expectTypeOf(ctx.errors.not_allowed).toBeFunction()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("error types edge cases", () => {
	it("multiple error keys from single defineErrors", () => {
		const factory = defineErrors({
			conflict: "conflict",
			forbidden: "forbidden",
			not_found: "not_found",
			rate_limited: "too_many_requests",
		})

		honey<{}>()
			.get("/test")
			.errors(factory, "not_found", "forbidden", "rate_limited")
			.handler((ctx) => {
				expectTypeOf(ctx.errors.not_found).toBeFunction()
				expectTypeOf(ctx.errors.forbidden).toBeFunction()
				expectTypeOf(ctx.errors.rate_limited).toBeFunction()
				return ctx.res.text("ok", "ok")
			})
	})

	it("InferRouteErrors across multiple routes", () => {
		const factory = defineErrors({
			bad_input: "bad_request",
			not_found: "not_found",
		})

		const app = honey<{}>()
			.get("/a")
			.errors(factory, "not_found")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.post("/b")
			.errors(factory, "bad_input")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		type ErrorsA = InferRouteErrors<typeof app, "/a", "get">
		expectTypeOf<ErrorsA>().toEqualTypeOf<"not_found">()

		type ErrorsB = InferRouteErrors<typeof app, "/b", "post">
		expectTypeOf<ErrorsB>().toEqualTypeOf<"bad_input">()
	})

	it("defaultErrors + route errors union", () => {
		const factory = defineErrors({
			a: "bad_request",
			b: "forbidden",
			c: "not_found",
		})

		const app = honey<{}>()
			.errorFactory(factory)
			.defaultErrors("a")
			.get("/test")
			.errors("b", "c")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		type Errors = InferRouteErrors<typeof app, "/test", "get">
		expectTypeOf<"a">().toMatchTypeOf<Errors>()
		expectTypeOf<"b">().toMatchTypeOf<Errors>()
		expectTypeOf<"c">().toMatchTypeOf<Errors>()
	})

	it("factory error function accepts optional message", () => {
		const factory = defineErrors({ test_err: "bad_request" })
		const err = factory.test_err({ vars: { message: "custom message" } })
		expectTypeOf(err).toEqualTypeOf<HoneyError>()
	})

	it("error propagation through .route() sub-app", () => {
		const factory = defineErrors({ sub_err: "not_found" })

		const sub = honey<{}>()
			.get("/items")
			.errors(factory, "sub_err")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const app = honey<{}>().route(sub)

		type Errors = InferRouteErrors<typeof app, "/items", "get">
		expectTypeOf<Errors>().toEqualTypeOf<"sub_err">()
	})
})
