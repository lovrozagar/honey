import type { HoneyContext, WithOutput, HoneyError } from "@lovrozagar/honey"

export type BaseCtx = HoneyContext<{ API_KEY: string; DATABASE_URL: string }> & { logger: { info: (_msg: string) => void }; user: { id: string; role: "admin" | "member" } }

export type RouteSelector = "DELETE /methods/resource/:id" | "DELETE /out/no-content/:id" | "DELETE /status/no-content" | "GET /in/cookies" | "GET /in/headers" | "GET /in/none" | "GET /in/params/:orgId/members/:memberId" | "GET /in/search" | "GET /methods/resource" | "GET /out/binary" | "GET /out/csv" | "GET /out/html" | "GET /out/sse" | "GET /out/text" | "GET /out/xml" | "GET /status/ok" | "GET /stream/filtered" | "PATCH /methods/resource/:id" | "POST /in/file" | "POST /in/form" | "POST /in/json" | "POST /methods/resource" | "POST /out/multi-status" | "POST /rs/upload" | "POST /status/accepted" | "POST /status/created" | "PUT /in/all/:resourceId" | "PUT /methods/resource/:id"

declare module "@lovrozagar/honey" {
	interface HoneyCodegen {
		routeSelector: RouteSelector
	}
}

type CreateInFileRequest = { title: string; upload: string }

type CreateInFileResponse200 = { name: string; title: string }

type CreateInFormRequest = { password: string; username: string }

type CreateInFormResponse200 = { token: string }

type CreateInJsonRequest = { email: string; name: string }

type CreateInJsonResponse201 = { id: string }

type CreateMethodRequest = { name: string }

type CreateOutMultiStatuRequest = { slug: string }

type CreateOutMultiStatuResponse201 = { id: string; slug: string }

type CreateOutMultiStatuResponse409 = { existing: string; message: string }

type CreateRsRequest = { chunks: number; fileName: string }

type CreateRsResponse202 = { uploadId: string }

type CreateStatuRequest = { task: string }

type CreateStatuRequestAa6c2c = { x: string }

type CreateStatuResponse202 = { jobId: string }

type DeleteOutNoContentResponse404 = { error_key: "not_found"; fields: Record<string, { error_key: string; message: string; path: string }[]>; message: string; status: 404; status_key: string; success: false }

type Err400ValidationError = { error_key: "validation_error"; fields: Record<string, { error_key: string; message: string; path: string }[]>; message: string; status: 400; status_key: string; success: false }

type Err401Unauthorized = { error_key: "unauthorized"; fields: Record<string, { error_key: string; message: string; path: string }[]>; message: string; status: 401; status_key: string; success: false }

type GetInParamsMemberResponse200 = { memberId: string; orgId: string }

type ListInCookiesResponse200 = { locale: string; valid: boolean }

type ListInHeadersResponse200 = { accepted: boolean }

type ListInNoneResponse200 = { ping: "pong" }

type ListInSearchResponse200 = { results: string[] }

type ListMethodsResponse200 = { items: string[] }

type ListOutBinaryResponse200 = unknown

type ListOutCsvResponse200 = string

type ListStatusResponse200 = { v: number }

type ReplaceInAllRequest = { data: Record<string, unknown> }

type ReplaceInAllResponse200 = { etag: string; version: number }

type ReplaceMethodsResourceResponse200 = { id: string; name: string }

type UpdateMethodsResourceRequest = { name?: string }

export type Routes = {
	"/in/all/:resourceId": {
		put: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { headers: { "if-match": string }; json: { data: Record<string, unknown> }; search: { version: number; force?: false | true } }; readonly params: { resourceId: string }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/in/all/:resourceId" }, { "application/json": { ok: ReplaceInAllResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { headers: { "if-match": string }; json: { data: Record<string, unknown> }; search: { version: number; force?: false | true } }
			meta: {}
			output: { "application/json": { ok: ReplaceInAllResponse200 } }
		}
	}
	"/in/cookies": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { cookies: { locale: string; sid: string } }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/in/cookies" }, { "application/json": { ok: ListInCookiesResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { cookies: { locale: string; sid: string } }
			meta: {}
			output: { "application/json": { ok: ListInCookiesResponse200 } }
		}
	}
	"/in/file": {
		post: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { form: { title: string; upload: import("../../../../../../../../node_modules/zod/v4/core/schemas.d.cts").File } }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/in/file" }, { "application/json": { ok: CreateInFileResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { form: { title: string; upload: import("../../../../../../../../node_modules/zod/v4/core/schemas.d.cts").File } }
			meta: {}
			output: { "application/json": { ok: CreateInFileResponse200 } }
		}
	}
	"/in/form": {
		post: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { form: { password: string; username: string } }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{ operationId: "input.createForm"; tags: ["input"] }>; readonly routePattern: "/in/form" }, { "application/json": { ok: CreateInFormResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { form: { password: string; username: string } }
			meta: { operationId: "input.createForm"; tags: ["input"] }
			output: { "application/json": { ok: CreateInFormResponse200 } }
		}
	}
	"/in/headers": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { headers: { "x-api-key": string; "x-request-id": string } }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/in/headers" }, { "application/json": { ok: ListInHeadersResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { headers: { "x-api-key": string; "x-request-id": string } }
			meta: {}
			output: { "application/json": { ok: ListInHeadersResponse200 } }
		}
	}
	"/in/json": {
		post: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { json: { email: string; name: string } }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{ operationId: "input.createJson"; tags: ["input"] }>; readonly routePattern: "/in/json" }, { "application/json": { created: CreateInJsonResponse201 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { json: { email: string; name: string } }
			meta: { operationId: "input.createJson"; tags: ["input"] }
			output: { "application/json": { created: CreateInJsonResponse201 } }
		}
	}
	"/in/none": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{ operationId: "input.none"; tags: ["input"] }>; readonly routePattern: "/in/none" }, { "application/json": { ok: ListInNoneResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: {}
			meta: { operationId: "input.none"; tags: ["input"] }
			output: { "application/json": { ok: ListInNoneResponse200 } }
		}
	}
	"/in/params/:orgId/members/:memberId": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { params: { memberId: string; orgId: string } }; readonly params: { orgId: string; memberId: string }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/in/params/:orgId/members/:memberId" }, { "application/json": { ok: GetInParamsMemberResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { params: { memberId: string; orgId: string } }
			meta: {}
			output: { "application/json": { ok: GetInParamsMemberResponse200 } }
		}
	}
	"/in/search": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { search: { limit: number; page: number; q?: string } }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{ operationId: "input.search"; tags: ["input"] }>; readonly routePattern: "/in/search" }, { "application/json": { ok: ListInSearchResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { search: { limit: number; page: number; q?: string } }
			meta: { operationId: "input.search"; tags: ["input"] }
			output: { "application/json": { ok: ListInSearchResponse200 } }
		}
	}
	"/methods/resource": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{ operationId: "resources.list"; tags: ["methods"] }>; readonly routePattern: "/methods/resource" }, { "application/json": { ok: ListMethodsResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: {}
			meta: { operationId: "resources.list"; tags: ["methods"] }
			output: { "application/json": { ok: ListMethodsResponse200 } }
		}
		post: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { json: { name: string } }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{ operationId: "resources.create"; tags: ["methods"] }>; readonly routePattern: "/methods/resource" }, { "application/json": { created: CreateInJsonResponse201 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { json: { name: string } }
			meta: { operationId: "resources.create"; tags: ["methods"] }
			output: { "application/json": { created: CreateInJsonResponse201 } }
		}
	}
	"/methods/resource/:id": {
		delete: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly params: { id: string }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{ operationId: "resources.delete"; tags: ["methods"] }>; readonly routePattern: "/methods/resource/:id" }, never>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: {}
			meta: { operationId: "resources.delete"; tags: ["methods"] }
			output: {}
		}
		patch: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { json: { name?: string }; params: { id: string } }; readonly params: { id: string }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{ operationId: "resources.patch"; tags: ["methods"] }>; readonly routePattern: "/methods/resource/:id" }, { "application/json": { ok: CreateInJsonResponse201 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { json: { name?: string }; params: { id: string } }
			meta: { operationId: "resources.patch"; tags: ["methods"] }
			output: { "application/json": { ok: CreateInJsonResponse201 } }
		}
		put: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { json: { name: string }; params: { id: string } }; readonly params: { id: string }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{ operationId: "resources.update"; tags: ["methods"] }>; readonly routePattern: "/methods/resource/:id" }, { "application/json": { ok: ReplaceMethodsResourceResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { json: { name: string }; params: { id: string } }
			meta: { operationId: "resources.update"; tags: ["methods"] }
			output: { "application/json": { ok: ReplaceMethodsResourceResponse200 } }
		}
	}
	"/out/binary": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/out/binary" }, { "application/octet-stream": { ok: ListOutBinaryResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: {}
			meta: {}
			output: { "application/octet-stream": { ok: ListOutBinaryResponse200 } }
		}
	}
	"/out/csv": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/out/csv" }, { "text/csv": { ok: ListOutCsvResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: {}
			meta: {}
			output: { "text/csv": { ok: ListOutCsvResponse200 } }
		}
	}
	"/out/html": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/out/html" }, { "text/html": { ok: ListOutCsvResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: {}
			meta: {}
			output: { "text/html": { ok: ListOutCsvResponse200 } }
		}
	}
	"/out/multi-status": {
		post: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { json: { slug: string } }; readonly errors: { conflict: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/out/multi-status" }, { "application/json": { created: CreateOutMultiStatuResponse201; conflict: CreateOutMultiStatuResponse409 } }>
			errors: "conflict" | "unauthorized" | "validation_error"
			errorShapes: { conflict: null; unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null; 409: null }
			input: { json: { slug: string } }
			meta: {}
			output: { "application/json": { created: CreateOutMultiStatuResponse201; conflict: CreateOutMultiStatuResponse409 } }
		}
	}
	"/out/no-content/:id": {
		delete: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly params: { id: string }; readonly errors: { not_found: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/out/no-content/:id" }, never>
			errors: "not_found" | "unauthorized" | "validation_error"
			errorShapes: { not_found: null; unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null; 404: null }
			input: {}
			meta: {}
			output: {}
		}
	}
	"/out/sse": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/out/sse" }, { "text/event-stream": { ok: ListOutCsvResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: {}
			meta: {}
			output: { "text/event-stream": { ok: ListOutCsvResponse200 } }
		}
	}
	"/out/text": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/out/text" }, { "text/plain": { ok: ListOutCsvResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: {}
			meta: {}
			output: { "text/plain": { ok: ListOutCsvResponse200 } }
		}
	}
	"/out/xml": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/out/xml" }, { "application/xml": { ok: ListOutCsvResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: {}
			meta: {}
			output: { "application/xml": { ok: ListOutCsvResponse200 } }
		}
	}
	"/rs/upload": {
		post: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/rs/upload" }, { "application/json": { accepted: CreateRsResponse202 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: {}
			meta: {}
			output: { "application/json": { accepted: CreateRsResponse202 } }
		}
	}
	"/status/accepted": {
		post: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { json: { task: string } }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/status/accepted" }, { "application/json": { accepted: CreateStatuResponse202 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { json: { task: string } }
			meta: {}
			output: { "application/json": { accepted: CreateStatuResponse202 } }
		}
	}
	"/status/created": {
		post: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { json: { x: string } }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/status/created" }, { "application/json": { created: CreateInJsonResponse201 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { json: { x: string } }
			meta: {}
			output: { "application/json": { created: CreateInJsonResponse201 } }
		}
	}
	"/status/no-content": {
		delete: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/status/no-content" }, never>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: {}
			meta: {}
			output: {}
		}
	}
	"/status/ok": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/status/ok" }, { "application/json": { ok: ListStatusResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: {}
			meta: {}
			output: { "application/json": { ok: ListStatusResponse200 } }
		}
	}
	"/stream/filtered": {
		get: {
			ctx: WithOutput<Omit<BaseCtx, "errors"> & { readonly input: { search: { channel: string; since?: string } }; readonly errors: { unauthorized: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError; validation_error: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError }; readonly meta: Readonly<{}>; readonly routePattern: "/stream/filtered" }, { "text/event-stream": { ok: ListOutCsvResponse200 } }>
			errors: "unauthorized" | "validation_error"
			errorShapes: { unauthorized: null; validation_error: null }
			errorsByStatus: { 400: null; 401: null }
			input: { search: { channel: string; since?: string } }
			meta: {}
			output: { "text/event-stream": { ok: ListOutCsvResponse200 } }
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
