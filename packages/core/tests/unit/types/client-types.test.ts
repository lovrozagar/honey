import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import type { SSEEvent } from "../../../src/client/sse.ts"
import type {
	ClientInput,
	ClientResult,
	ErrorsFor,
	HoneyClient,
	InputFor,
	IsSSE,
	OutputDefFor,
	OutputFor,
	PathsForMethod,
	ReturnFor,
} from "../../../src/client/types.ts"
import { defineErrors, honey } from "../../../src/index.ts"
import type { InferRoutes } from "../../../src/types.ts"

/* fixture app */
const errs = defineErrors({ not_found: "not_found" })

const app = honey<{}>()
	.get("/health")
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/users")
	.output({ "application/json": { ok: z.object({ id: z.string(), name: z.string() }).array() } })
	.handler((ctx) => ctx.res.json("ok", [{ id: "1", name: "test" }]))
	.get("/users/:id")
	.output({ "application/json": { ok: z.object({ id: z.string(), name: z.string() }) } })
	.errors(errs, "not_found")
	.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, name: "test" }))
	.post("/users")
	.input({ json: z.object({ name: z.string() }) })
	.output({ "application/json": { created: z.object({ id: z.string() }) } })
	.handler((ctx) => ctx.res.json("created", { id: "1" }))
	.get("/events")
	.output({ "text/event-stream": { ok: z.object({ data: z.string() }) } })
	.handler((ctx) => ctx.res.sse(async () => {}))
	.get("/download")
	.output({ "application/octet-stream": { ok: z.instanceof(Uint8Array) } })
	.handler((ctx) => ctx.res.binary("ok", new Uint8Array()))
	.get("/page")
	.output({ "text/html": { ok: z.string() } })
	.handler((ctx) => ctx.res.html("ok", "<h1>hi</h1>"))

type Routes = InferRoutes<typeof app>

describe("PathsForMethod", () => {
	it("returns only paths with GET", () => {
		type GetPaths = PathsForMethod<Routes, "get">
		expectTypeOf<"/health">().toMatchTypeOf<GetPaths>()
		expectTypeOf<"/users">().toMatchTypeOf<GetPaths>()
		expectTypeOf<"/users/:id">().toMatchTypeOf<GetPaths>()
		expectTypeOf<"/events">().toMatchTypeOf<GetPaths>()
	})

	it("returns only paths with POST", () => {
		type PostPaths = PathsForMethod<Routes, "post">
		expectTypeOf<"/users">().toMatchTypeOf<PostPaths>()
	})
})

describe("InputFor", () => {
	it("extracts input type for route with input", () => {
		type Input = InputFor<Routes, "/users", "post">
		expectTypeOf<Input>().toEqualTypeOf<{ json: { name: string } }>()
	})

	it("returns empty for route without input", () => {
		type Input = InputFor<Routes, "/health", "get">
		expectTypeOf<Input>().toEqualTypeOf<{}>()
	})
})

describe("OutputFor", () => {
	it("infers JSON output from schema", () => {
		type Output = OutputFor<Routes, "/users/:id", "get">
		expectTypeOf<Output>().toEqualTypeOf<{ id: string; name: string }>()
	})

	it("returns string for text/html output", () => {
		type Output = OutputFor<Routes, "/page", "get">
		expectTypeOf<Output>().toEqualTypeOf<string>()
	})

	it("returns ArrayBuffer for binary output", () => {
		type Output = OutputFor<Routes, "/download", "get">
		expectTypeOf<Output>().toEqualTypeOf<ArrayBuffer>()
	})

	it("returns null for no output declared", () => {
		type Output = OutputFor<Routes, "/health", "get">
		expectTypeOf<Output>().toEqualTypeOf<null>()
	})
})

describe("IsSSE", () => {
	it("true for SSE route", () => {
		expectTypeOf<IsSSE<Routes, "/events", "get">>().toEqualTypeOf<true>()
	})

	it("false for non-SSE route", () => {
		expectTypeOf<IsSSE<Routes, "/users", "get">>().toEqualTypeOf<false>()
	})
})

describe("ClientInput", () => {
	it("merges route input with params from path", () => {
		type Input = ClientInput<Routes, "/users/:id", "get">
		expectTypeOf<Input>().toMatchTypeOf<{ params: { id: string } }>()
	})

	it("no params for static path", () => {
		type Input = ClientInput<Routes, "/health", "get">
		expectTypeOf<Input>().toEqualTypeOf<{}>()
	})

	it("includes json body for POST", () => {
		type Input = ClientInput<Routes, "/users", "post">
		expectTypeOf<Input>().toMatchTypeOf<{ json: { name: string } }>()
	})
})

describe("ReturnFor", () => {
	it("SSE routes return AsyncIterable regardless of throw mode", () => {
		expectTypeOf<ReturnFor<Routes, "/events", "get", true>>().toEqualTypeOf<
			AsyncIterable<SSEEvent>
		>()
		expectTypeOf<ReturnFor<Routes, "/events", "get", false>>().toEqualTypeOf<
			AsyncIterable<SSEEvent>
		>()
	})

	it("throw mode returns Promise<data>", () => {
		type R = ReturnFor<Routes, "/users/:id", "get", true>
		expectTypeOf<R>().toEqualTypeOf<Promise<{ id: string; name: string }>>()
	})

	it("safe mode returns Promise<ClientResult<data, errorsByStatus>>", () => {
		type R = ReturnFor<Routes, "/users/:id", "get", false>
		expectTypeOf<R>().toEqualTypeOf<
			Promise<ClientResult<{ id: string; name: string }, { 404: null }>>
		>()
	})
})

describe("ErrorsFor", () => {
	it("extracts error keys for route with errors", () => {
		type E = ErrorsFor<Routes, "/users/:id", "get">
		expectTypeOf<E>().toEqualTypeOf<"not_found">()
	})

	it("returns never for route without errors", () => {
		type E = ErrorsFor<Routes, "/health", "get">
		expectTypeOf<E>().toBeNever()
	})
})

describe("HoneyClient", () => {
	it("get method constrained to GET paths", () => {
		type Client = HoneyClient<Routes>
		type GetFn = Client["get"]
		expectTypeOf<GetFn>().toBeFunction()
	})

	it("post method constrained to POST paths", () => {
		type Client = HoneyClient<Routes>
		type PostFn = Client["post"]
		expectTypeOf<PostFn>().toBeFunction()
	})

	it("$path constrained to registered paths", () => {
		type Client = HoneyClient<Routes>
		type PathFn = Client["$path"]
		expectTypeOf<PathFn>().toBeFunction()
	})

	it("$url constrained to registered paths", () => {
		type Client = HoneyClient<Routes>
		type UrlFn = Client["$url"]
		expectTypeOf<UrlFn>().toBeFunction()
	})

	it("$isClientError is a type guard", () => {
		type Client = HoneyClient<Routes>
		expectTypeOf<Client["$isClientError"]>().toBeFunction()
	})
})

describe("client edge cases", () => {
	it("DELETE/PATCH/PUT paths", () => {
		const multiApp = honey<{}>()
			.delete("/items/:id")
			.handler((ctx) => ctx.res.noContent())
			.patch("/items/:id")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
			.put("/items/:id")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		type MultiRoutes = InferRoutes<typeof multiApp>

		type DelPaths = PathsForMethod<MultiRoutes, "delete">
		expectTypeOf<"/items/:id">().toMatchTypeOf<DelPaths>()

		type PatchPaths = PathsForMethod<MultiRoutes, "patch">
		expectTypeOf<"/items/:id">().toMatchTypeOf<PatchPaths>()

		type PutPaths = PathsForMethod<MultiRoutes, "put">
		expectTypeOf<"/items/:id">().toMatchTypeOf<PutPaths>()
	})

	it("OutputFor returns string for text/csv", () => {
		const csvApp = honey<{}>()
			.get("/export")
			.output({ "text/csv": { ok: z.string() } })
			.handler((ctx) => ctx.res.csv("ok", "a,b"))

		type CsvRoutes = InferRoutes<typeof csvApp>
		type Output = OutputFor<CsvRoutes, "/export", "get">
		expectTypeOf<Output>().toEqualTypeOf<string>()
	})

	it("OutputFor returns string for application/xml", () => {
		const xmlApp = honey<{}>()
			.get("/feed")
			.output({ "application/xml": { ok: z.string() } })
			.handler((ctx) => ctx.res.xml("ok", "<root/>"))

		type XmlRoutes = InferRoutes<typeof xmlApp>
		type Output = OutputFor<XmlRoutes, "/feed", "get">
		expectTypeOf<Output>().toEqualTypeOf<string>()
	})

	it("OutputFor with array output", () => {
		const arrApp = honey<{}>()
			.get("/items")
			.output({ "application/json": { ok: z.object({ id: z.string() }).array() } })
			.handler((ctx) => ctx.res.json("ok", [{ id: "1" }]))

		type ArrRoutes = InferRoutes<typeof arrApp>
		type Output = OutputFor<ArrRoutes, "/items", "get">
		expectTypeOf<Output>().toEqualTypeOf<{ id: string }[]>()
	})

	it("ClientInput with params + json body", () => {
		type Input = ClientInput<Routes, "/users", "post">
		expectTypeOf<Input>().toMatchTypeOf<{ json: { name: string } }>()
	})

	it("ClientInput with param route has params key", () => {
		type Input = ClientInput<Routes, "/users/:id", "get">
		expectTypeOf<Input>().toMatchTypeOf<{ params: { id: string } }>()
	})

	it("ReturnFor with no output returns null in throw mode", () => {
		type R = ReturnFor<Routes, "/health", "get", true>
		expectTypeOf<R>().toEqualTypeOf<Promise<null>>()
	})

	it("ReturnFor HTML returns string", () => {
		type R = ReturnFor<Routes, "/page", "get", true>
		expectTypeOf<R>().toEqualTypeOf<Promise<string>>()
	})

	it("ReturnFor binary returns ArrayBuffer", () => {
		type R = ReturnFor<Routes, "/download", "get", true>
		expectTypeOf<R>().toEqualTypeOf<Promise<ArrayBuffer>>()
	})

	it("ErrorsFor returns never for routes without errors", () => {
		type E = ErrorsFor<Routes, "/users", "get">
		expectTypeOf<E>().toBeNever()
	})

	it("basePath routes accessible via prefixed path in client types", () => {
		const bpApp = honey<{}>()
			.basePath("/api")
			.get("/users")
			.output({ "application/json": { ok: z.object({ id: z.string() }).array() } })
			.handler((ctx) => ctx.res.json("ok", [{ id: "1" }]))

		type BpRoutes = InferRoutes<typeof bpApp>
		type Paths = PathsForMethod<BpRoutes, "get">
		expectTypeOf<"/api/users">().toMatchTypeOf<Paths>()

		type Output = OutputFor<BpRoutes, "/api/users", "get">
		expectTypeOf<Output>().toEqualTypeOf<{ id: string }[]>()
	})
})

describe("ClientResult discriminated union", () => {
	it("success branch has data and null error", () => {
		type Success = Extract<ClientResult<{ id: string }>, { error: null }>
		expectTypeOf<Success>().toMatchTypeOf<{
			data: { id: string }
			error: null
			response: Response
			status: number
		}>()
	})

	it("error branch has null data and unknown body when no errorsByStatus", () => {
		type Failure = Extract<ClientResult<{ id: string }>, { data: null }>
		expectTypeOf<Failure>().toMatchTypeOf<{
			data: null
			error: unknown
			response: Response
			status: number
		}>()
	})

	it("both branches have response and status", () => {
		type R = ClientResult<string>
		expectTypeOf<R>().toMatchTypeOf<{ response: Response; status: number }>()
	})
})

describe("OutputDefFor", () => {
	it("extracts raw output definition", () => {
		type OD = OutputDefFor<Routes, "/users/:id", "get">
		expectTypeOf<OD>().toMatchTypeOf<{
			"application/json": { ok: z.ZodObject<{ id: z.ZodString; name: z.ZodString }> }
		}>()
	})

	it("returns never for route without output", () => {
		type OD = OutputDefFor<Routes, "/health", "get">
		expectTypeOf<OD>().toMatchTypeOf<{}>()
	})
})

describe("HoneyClient throw vs safe mode", () => {
	it("throw mode client get returns Promise<data>", () => {
		type ThrowClient = HoneyClient<Routes, true>
		type GetFn = ThrowClient["get"]
		expectTypeOf<GetFn>().toBeFunction()
	})

	it("safe mode client get returns Promise<ClientResult<data>>", () => {
		type SafeClient = HoneyClient<Routes, false>
		type GetFn = SafeClient["get"]
		expectTypeOf<GetFn>().toBeFunction()
	})

	it("default TThrow is false (safe mode)", () => {
		type DefaultClient = HoneyClient<Routes>
		type GetFn = DefaultClient["get"]
		expectTypeOf<GetFn>().toBeFunction()
	})
})

describe("nested .route() client types", () => {
	it("deeply nested route sub-apps merge paths", () => {
		const users = honey<{}>()
			.get("/")
			.output({ "application/json": { ok: z.object({ id: z.string() }).array() } })
			.handler((ctx) => ctx.res.json("ok", [{ id: "1" }]))
			.get("/:id")
			.output({ "application/json": { ok: z.object({ id: z.string(), name: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, name: "test" }))

		const api = honey<{}>().basePath("/api").route(users)

		type ApiRoutes = InferRoutes<typeof api>
		type Paths = PathsForMethod<ApiRoutes, "get">
		expectTypeOf<Paths>().toMatchTypeOf<"/" | "/:id">()
	})

	it("multiple sub-apps with different methods", () => {
		const items = honey<{}>()
			.get("/items")
			.handler((ctx) => ctx.res.json("ok", []))
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", { id: "1" }))

		const tags = honey<{}>()
			.get("/tags")
			.handler((ctx) => ctx.res.json("ok", []))

		const combined = honey<{}>().route(items).route(tags)

		type CombinedRoutes = InferRoutes<typeof combined>
		expectTypeOf<PathsForMethod<CombinedRoutes, "get">>().toMatchTypeOf<"/items" | "/tags">()
		expectTypeOf<PathsForMethod<CombinedRoutes, "post">>().toMatchTypeOf<"/items">()
	})
})

describe("IsSSE edge cases", () => {
	it("false for route with json + text but no SSE", () => {
		const multiApp = honey<{}>()
			.get("/data")
			.output({
				"application/json": { ok: z.object({ id: z.string() }) },
				"text/plain": { ok: z.string() },
			})
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

		type MultiRoutes = InferRoutes<typeof multiApp>
		expectTypeOf<IsSSE<MultiRoutes, "/data", "get">>().toEqualTypeOf<false>()
	})
})
