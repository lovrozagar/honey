import type { HoneyContext, WithOutput, HoneyError } from "@lovrozagar/honey"

export type BaseCtx = HoneyContext<Record<string, unknown>> & { requestId: string }

export type RouteSelector = "ALL /api/echo" | "DELETE /api/v1/organizations/:orgId" | "GET /api" | "GET /api/boundary/custom" | "GET /api/boundary/default" | "GET /api/events" | "GET /api/events-live" | "GET /api/health" | "GET /api/v1/organizations" | "GET /api/v1/organizations/:orgId" | "POST /api/realtime/broadcast/:topic" | "POST /api/v1/organizations"

declare module "@lovrozagar/honey" {
	interface HoneyCodegen {
		routeSelector: RouteSelector
	}
}

type CreateApiV1OrganizationResponse409 = { error_key: "org_slug_taken"; fields: Record<string, { error_key: string; message: string; path: string }[]>; message: string; status: 409; status_key: string; success: false }

type Err400InvalidInput = { error_key: "invalid_input"; fields: Record<string, { error_key: string; message: string; path: string }[]>; message: string; status: 400; status_key: string; success: false }

type Err401Unauthorized = { error_key: "unauthorized"; fields: Record<string, { error_key: string; message: string; path: string }[]>; message: string; status: 401; status_key: string; success: false }

type Err403OrgLimitReached = { error_key: "org_limit_reached"; fields: Record<string, { error_key: string; message: string; path: string }[]>; message: string; status: 403; status_key: string; success: false }

type Err500ApiError = { error_key: "api_error"; fields: Record<string, { error_key: string; message: string; path: string }[]>; message: string; status: 500; status_key: string; success: false }

type ListApiEventsResponse200 = string

type ListApiResponse200 = { id: string }

export type Routes = {
	"/api": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { search: { id: string } }; readonly errors: { api_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; invalid_input: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{ description: "Test route"; summary: "Root test route"; tags: ["test"] }>; readonly routePattern: "/api" }, { "application/json": { ok: ListApiResponse200 } }>
			errors: "api_error" | "invalid_input" | "unauthorized"
			errorShapes: { api_error: null; invalid_input: null; unauthorized: null }
			errorsByStatus: { 400: null; 401: null; 500: null }
			input: { search: { id: string } }
			meta: { description: "Test route"; summary: "Root test route"; tags: ["test"] }
			output: { "application/json": { ok: ListApiResponse200 } }
		}
	}
	"/api/boundary/custom": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { api_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; org_limit_reached: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/api/boundary/custom" }, never>
			errors: "api_error" | "org_limit_reached" | "unauthorized"
			errorShapes: { api_error: null; org_limit_reached: null; unauthorized: null }
			errorsByStatus: { 401: null; 403: null; 500: null }
			input: {}
			meta: {}
			output: {}
		}
	}
	"/api/boundary/default": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { api_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/api/boundary/default" }, never>
			errors: "api_error" | "unauthorized"
			errorShapes: { api_error: null; unauthorized: null }
			errorsByStatus: { 401: null; 500: null }
			input: {}
			meta: {}
			output: {}
		}
	}
	"/api/echo": {
		all: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { api_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/api/echo" }, never>
			errors: "api_error" | "unauthorized"
			errorShapes: { api_error: null; unauthorized: null }
			errorsByStatus: { 401: null; 500: null }
			input: {}
			meta: {}
			output: {}
		}
	}
	"/api/events": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { api_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/api/events" }, { "text/event-stream": { ok: ListApiEventsResponse200 } }>
			errors: "api_error" | "unauthorized"
			errorShapes: { api_error: null; unauthorized: null }
			errorsByStatus: { 401: null; 500: null }
			input: {}
			meta: {}
			output: { "text/event-stream": { ok: ListApiEventsResponse200 } }
		}
	}
	"/api/events-live": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { api_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/api/events-live" }, { "text/event-stream": { ok: ListApiEventsResponse200 } }>
			errors: "api_error" | "unauthorized"
			errorShapes: { api_error: null; unauthorized: null }
			errorsByStatus: { 401: null; 500: null }
			input: {}
			meta: {}
			output: { "text/event-stream": { ok: ListApiEventsResponse200 } }
		}
	}
	"/api/health": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { api_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/api/health" }, never>
			errors: "api_error" | "unauthorized"
			errorShapes: { api_error: null; unauthorized: null }
			errorsByStatus: { 401: null; 500: null }
			input: {}
			meta: {}
			output: {}
		}
	}
	"/api/realtime/broadcast/:topic": {
		post: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly params: { topic: string }; readonly errors: { api_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/api/realtime/broadcast/:topic" }, never>
			errors: "api_error" | "unauthorized"
			errorShapes: { api_error: null; unauthorized: null }
			errorsByStatus: { 401: null; 500: null }
			input: {}
			meta: {}
			output: {}
		}
	}
	"/api/v1/organizations": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { db: { orgs: { id: string; name: string; slug: string }[] }; user: { id: string; locale: string; name: string } } & { readonly errors: { api_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/api/v1/organizations" }, never>
			errors: "api_error" | "unauthorized"
			errorShapes: { api_error: null; unauthorized: null }
			errorsByStatus: { 401: null; 500: null }
			input: {}
			meta: {}
			output: {}
		}
		post: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { db: { orgs: { id: string; name: string; slug: string }[] }; user: { id: string; locale: string; name: string } } & { readonly errors: { api_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; invalid_input: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; org_limit_reached: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; org_slug_taken: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/api/v1/organizations" }, never>
			errors: "api_error" | "invalid_input" | "org_limit_reached" | "org_slug_taken" | "unauthorized"
			errorShapes: { api_error: null; invalid_input: null; org_limit_reached: null; org_slug_taken: null; unauthorized: null }
			errorsByStatus: { 400: null; 401: null; 403: null; 409: null; 500: null }
			input: {}
			meta: {}
			output: {}
		}
	}
	"/api/v1/organizations/:orgId": {
		delete: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { db: { orgs: { id: string; name: string; slug: string }[] }; user: { id: string; locale: string; name: string } } & { readonly params: { orgId: string }; readonly errors: { api_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/api/v1/organizations/:orgId" }, never>
			errors: "api_error" | "unauthorized"
			errorShapes: { api_error: null; unauthorized: null }
			errorsByStatus: { 401: null; 500: null }
			input: {}
			meta: {}
			output: {}
		}
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { db: { orgs: { id: string; name: string; slug: string }[] }; user: { id: string; locale: string; name: string } } & { readonly params: { orgId: string }; readonly errors: { api_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/api/v1/organizations/:orgId" }, never>
			errors: "api_error" | "unauthorized"
			errorShapes: { api_error: null; unauthorized: null }
			errorsByStatus: { 401: null; 500: null }
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
