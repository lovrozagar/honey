import type { HoneyContext, WithOutput } from "@lovrozagar/honey"

export type BaseCtx = HoneyContext<unknown>

export type RouteSelector = "GET /articles" | "GET /articles/meta" | "GET /nl/c/:delivery/:url" | "GET /ping" | "GET /users" | "GET /users/:id" | "GET /v1/openapi/spec"

declare module "@lovrozagar/honey" {
	interface HoneyCodegen {
		routeSelector: RouteSelector
	}
}

type ListArticlesResponse200 = { articles: { id: string; title: string }[]; count: number; hasMore: boolean; nextCursor: string | null }

export type Routes = {
	"/articles": {
		get: {
			ctx: WithOutput<BaseCtx & { readonly input: { search: { cursor?: string } }; readonly meta: Readonly<{ tenant: "project_id"; permissions: ["articles.read"]; summary: "List articles"; worker: "origin" }>; readonly routePattern: "/articles" }, { "application/json": { ok: ListArticlesResponse200 } }>
			errors: never
			input: { search: { cursor?: string } }
			meta: { tenant: "project_id"; permissions: ["articles.read"]; summary: "List articles"; worker: "origin" }
			output: { "application/json": { ok: ListArticlesResponse200 } }
		}
	}
	"/articles/meta": {
		get: {
			ctx: WithOutput<BaseCtx & { readonly meta: Readonly<{ tenant: "project_id" }>; readonly routePattern: "/articles/meta" }, never>
			errors: never
			input: {}
			meta: { tenant: "project_id" }
			output: {}
		}
	}
	"/nl/c/:delivery/:url": {
		get: {
			ctx: WithOutput<BaseCtx & { readonly params: { delivery: string; url: string }; readonly meta: Readonly<{}>; readonly routePattern: "/nl/c/:delivery/:url" }, never>
			errors: never
			input: {}
			meta: {}
			output: {}
		}
	}
	"/ping": {
		get: {
			ctx: WithOutput<BaseCtx & { readonly meta: Readonly<{}>; readonly routePattern: "/ping" }, never>
			errors: never
			input: {}
			meta: {}
			output: {}
		}
	}
	"/users": {
		get: {
			ctx: WithOutput<BaseCtx & { readonly meta: Readonly<{ worker: "origin" }>; readonly routePattern: "/users" }, never>
			errors: never
			input: {}
			meta: { worker: "origin" }
			output: {}
		}
	}
	"/users/:id": {
		get: {
			ctx: WithOutput<BaseCtx & { readonly params: { id: string }; readonly meta: Readonly<{ worker: "origin" }>; readonly routePattern: "/users/:id" }, never>
			errors: never
			input: {}
			meta: { worker: "origin" }
			output: {}
		}
	}
	"/v1/openapi/spec": {
		get: {
			ctx: WithOutput<BaseCtx & { readonly meta: Readonly<{}>; readonly routePattern: "/v1/openapi/spec" }, never>
			errors: never
			input: {}
			meta: {}
			output: {}
		}
	}
}

export type RouteCtx<TPath extends keyof Routes, TMethod extends keyof Routes[TPath] & string> = Routes[TPath][TMethod] extends { ctx: infer T } ? T : never

export type RouteInput<TPath extends keyof Routes, TMethod extends keyof Routes[TPath] & string> = Routes[TPath][TMethod] extends { input: infer T } ? T : never

export type RouteOutput<TPath extends keyof Routes, TMethod extends keyof Routes[TPath] & string> = Routes[TPath][TMethod] extends { output: infer T } ? T : never

export type RouteErrors<TPath extends keyof Routes, TMethod extends keyof Routes[TPath] & string> = Routes[TPath][TMethod] extends { errors: infer T } ? T : never

export type RouteErrorShapes<TPath extends keyof Routes, TMethod extends keyof Routes[TPath] & string> = Routes[TPath][TMethod] extends { errorShapes: infer T } ? T : never

export type RouteErrorsByStatus<TPath extends keyof Routes, TMethod extends keyof Routes[TPath] & string> = Routes[TPath][TMethod] extends { errorsByStatus: infer T } ? T : never

export type RouteMeta<TPath extends keyof Routes, TMethod extends keyof Routes[TPath] & string> = Routes[TPath][TMethod] extends { meta: infer T } ? T : never
