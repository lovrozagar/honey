import type { ClientConfig, LogEntry, OnRequestContext, OnResponseContext, RequestMeta } from "./config.ts"
import { isReplayable } from "./request.ts"

/** Where a response hook runs: the request as sent, its answer, and how to send it again. */
export type ResponseAt = {
	init: RequestInit
	isRetry: boolean
	meta: RequestMeta | undefined
	method: string
	path: string
	response: Response
	retry: () => Promise<Response>
	state: Record<string, unknown>
	url: URL
}

/** `ctx` with the read's stale view, when the SDK tracks one. */
function withMeta<T extends object>(ctx: T, meta: RequestMeta | undefined): T {
	if (meta) Object.assign(ctx, { invalidatedBy: meta.invalidatedBy, isStale: meta.isStale, selector: meta.selector })
	return ctx
}

/** Let each `onRequest` hook see the request and change it; resolves to the body it now sends. */
export async function runRequestHooks(
	hooks: NonNullable<ClientConfig["onRequest"]>,
	ctx: OnRequestContext,
	meta: RequestMeta | undefined,
): Promise<BodyInit | undefined> {
	withMeta(ctx, meta)
	for (const hook of hooks) await hook(ctx)
	return ctx.body
}

/** Let each `onResponse` hook see the answer and replace it. */
export async function runResponseHooks(
	hooks: NonNullable<ClientConfig["onResponse"]>,
	at: ResponseAt,
): Promise<Response> {
	let request: Request | undefined
	const { init } = at
	const ctx: OnResponseContext = {
		isRetry: at.isRetry,
		method: at.method,
		path: at.path,
		get request() {
			/* built on demand: constructing a Request per response is not free */
			request ??= new Request(at.url.toString(), { ...init, body: isReplayable(init.body) ? init.body : undefined })
			return request
		},
		response: at.response,
		retry: () => (at.isRetry ? Promise.resolve(ctx.response) : at.retry()),
		state: at.state,
		url: at.url.toString(),
	}
	withMeta(ctx, at.meta)
	for (const hook of hooks) {
		const result = await hook(ctx)
		if (result instanceof Response) ctx.response = result
	}
	return ctx.response
}

/** The `onLog` entries of one exchange: its start now, then its answer or its failure, each with its duration. */
export function exchangeLog(
	onLog: ((entry: LogEntry) => void) | undefined,
	operation: string,
): { answered: (response: Response) => void; failed: (error: unknown) => void } {
	const start = Date.now()
	onLog?.({ duration_ms: 0, event: "request_start", level: "debug", operation })
	const took = () => Date.now() - start
	return {
		answered: (response) => {
			const level = response.status >= 400 ? "warn" : "info"
			onLog?.({ duration_ms: took(), event: "response_received", level, operation, status: response.status })
		},
		failed: (error) => {
			const status = (error as { status?: unknown } | null)?.status
			const entry: LogEntry = { duration_ms: took(), error, event: "error", level: "error", operation }
			onLog?.(typeof status === "number" ? { ...entry, status } : entry)
		},
	}
}
