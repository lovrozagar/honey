import type { HoneyContext, WithOutput } from "@lovrozagar/honey"

export type BaseCtx = HoneyContext<unknown>

export type RouteSelector = "GET /health" | "GET /users/:id" | "POST /echo"

declare module "@lovrozagar/honey" {
	interface HoneyCodegen {
		routeSelector: RouteSelector
	}
}

type CreateEchoResponse201 = string

export type Routes = {
	"/echo": {
		post: {
			ctx: WithOutput<BaseCtx & { readonly meta: Readonly<{}>; readonly routePattern: "/echo" }, { "application/json": { created: CreateEchoResponse201 } }>
			errors: never
			input: {}
			meta: {}
			output: { "application/json": { created: CreateEchoResponse201 } }
		}
	}
	"/health": {
		get: {
			ctx: WithOutput<BaseCtx & { readonly meta: Readonly<{}>; readonly routePattern: "/health" }, never>
			errors: never
			input: {}
			meta: {}
			output: {}
		}
	}
	"/users/:id": {
		get: {
			ctx: WithOutput<BaseCtx & { readonly params: { id: string }; readonly meta: Readonly<{}>; readonly routePattern: "/users/:id" }, never>
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
