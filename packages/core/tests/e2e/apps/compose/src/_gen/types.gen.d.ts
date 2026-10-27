import type { HoneyContext, WithOutput, HoneyError } from "@lovrozagar/honey"

export type BaseCtx = HoneyContext<{ JWT_SECRET: string; REDIS_URL: string }> & { cache: { get: (_k: string) => null | string; set: (_k: string, _v: string) => void }; session: { orgId: string; permissions: string[]; userId: string } }

export type RouteSelector = "DELETE /resources/:resourceId" | "GET /account" | "GET /docs" | "GET /feed" | "GET /health" | "GET /resources/:resourceId" | "POST /account/settings" | "POST /resources"

declare module "@lovrozagar/honey" {
	interface HoneyCodegen {
		routeSelector: RouteSelector
	}
}

type CreateAccountSettingRequest = { notifications: boolean; theme: "dark" | "light" }

type CreateResourceRequest = { name: string; type: "doc" | "image" | "video" }

type CreateResourceResponse429 = { error_key: "rate_limited"; fields: Record<string, { error_key: string; message: string; path: string }[]>; message: string; status: 429; status_key: string; success: false }

type Err401ExpiredTokenInvalidToken = { error_key: "expired_token" | "invalid_token"; fields: Record<string, { error_key: string; message: string; path: string }[]>; message: string; status: 401; status_key: string; success: false }

type Err403Forbidden = { error_key: "forbidden"; fields: Record<string, { error_key: string; message: string; path: string }[]>; message: string; status: 403; status_key: string; success: false }

type Err404NotFound = { error_key: "not_found"; fields: Record<string, { error_key: string; message: string; path: string }[]>; message: string; status: 404; status_key: string; success: false }

export type Routes = {
	"/account": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { expired_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; forbidden: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; invalid_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/account" }, never>
			errors: "expired_token" | "forbidden" | "invalid_token"
			errorShapes: { expired_token: null; forbidden: null; invalid_token: null }
			errorsByStatus: { 401: null; 403: null }
			input: {}
			meta: {}
			output: {}
		}
	}
	"/account/settings": {
		post: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { json: { notifications: boolean; theme: "dark" | "light" } }; readonly errors: { expired_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; forbidden: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; invalid_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/account/settings" }, never>
			errors: "expired_token" | "forbidden" | "invalid_token"
			errorShapes: { expired_token: null; forbidden: null; invalid_token: null }
			errorsByStatus: { 401: null; 403: null }
			input: { json: { notifications: boolean; theme: "dark" | "light" } }
			meta: {}
			output: {}
		}
	}
	"/docs": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { expired_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; invalid_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/docs" }, never>
			errors: "expired_token" | "invalid_token"
			errorShapes: { expired_token: null; invalid_token: null }
			errorsByStatus: { 401: null }
			input: {}
			meta: {}
			output: {}
		}
	}
	"/feed": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { search: { page: number } }; readonly errors: { expired_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; invalid_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/feed" }, never>
			errors: "expired_token" | "invalid_token"
			errorShapes: { expired_token: null; invalid_token: null }
			errorsByStatus: { 401: null }
			input: { search: { page: number } }
			meta: {}
			output: {}
		}
	}
	"/health": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { expired_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; invalid_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/health" }, never>
			errors: "expired_token" | "invalid_token"
			errorShapes: { expired_token: null; invalid_token: null }
			errorsByStatus: { 401: null }
			input: {}
			meta: {}
			output: {}
		}
	}
	"/resources": {
		post: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { json: { name: string; type: "doc" | "image" | "video" } }; readonly errors: { expired_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; forbidden: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; invalid_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; rate_limited: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/resources" }, never>
			errors: "expired_token" | "forbidden" | "invalid_token" | "rate_limited"
			errorShapes: { expired_token: null; forbidden: null; invalid_token: null; rate_limited: null }
			errorsByStatus: { 401: null; 403: null; 429: null }
			input: { json: { name: string; type: "doc" | "image" | "video" } }
			meta: {}
			output: {}
		}
	}
	"/resources/:resourceId": {
		delete: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly params: { resourceId: string }; readonly errors: { expired_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; forbidden: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; invalid_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; not_found: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/resources/:resourceId" }, never>
			errors: "expired_token" | "forbidden" | "invalid_token" | "not_found"
			errorShapes: { expired_token: null; forbidden: null; invalid_token: null; not_found: null }
			errorsByStatus: { 401: null; 403: null; 404: null }
			input: {}
			meta: {}
			output: {}
		}
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly params: { resourceId: string }; readonly errors: { expired_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; forbidden: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; invalid_token: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; not_found: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/resources/:resourceId" }, never>
			errors: "expired_token" | "forbidden" | "invalid_token" | "not_found"
			errorShapes: { expired_token: null; forbidden: null; invalid_token: null; not_found: null }
			errorsByStatus: { 401: null; 403: null; 404: null }
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
