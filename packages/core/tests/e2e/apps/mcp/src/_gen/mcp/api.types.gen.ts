import type { RealtimeOptions, ResumableConnection, SDKConfig, SSEEvent, TypedWebSocket } from "./api.runtime.gen"

export type CreateProjectsExtractRequest = { columns?: string; file?: string; instruction?: string; schema?: string; strictness?: "strict" | "balanced" | "flexible"; text?: string }
export type CreateProjectsExtractResponse200 = { files: { file_name: string; sha256: string; size: number }[]; status: string; texts: Record<string, string> }
export type CreateProjectsExtractStreamResponse200 = string
export type CreateProjectsSuggestSchemaRequest = { file?: string; text?: string }

export type HttpOptions = {
	baseURL?: string
	cookies?: Record<string, string>
	headers?: Record<string, string>
	idempotencyKey?: string
	signal?: AbortSignal
	timeout?: number
}
export type SseOptions = Omit<HttpOptions, "idempotencyKey"> & { lastEventId?: string }
export type WsOptions = { protocols?: string | string[]; reconnectToken?: string }
export type RealtimeCallOptions = Omit<HttpOptions, "idempotencyKey" | "timeout"> & RealtimeOptions

type ErrorField = { error_key: string; message: string; path: string }

/** honey's error envelope at one status, its error keys as literals. */
export type ErrorEnvelope<TStatus extends number, TKey extends string> = {
	error_key: TKey
	fields: Record<string, ErrorField[]>
	message: string
	status: TStatus
	status_key: string
	success: false
}

/**
 * A safe-mode result. With declared errors, the failure branch is keyed by exactly their statuses,
 * so `if (error)` / `if (!error)` narrow; with declared headers, the success branch carries them.
 */
export type SDKResult<T, TErrorsByStatus = never, THeaders = never> =
	| ([THeaders] extends [never]
			? { data: T; error: null; response: Response; status: number }
			: { data: T; error: null; headers: THeaders; response: Response; status: number })
	| ([TErrorsByStatus] extends [never]
			? { data: null; error: unknown; response: Response; status: number }
			: {
					[S in keyof TErrorsByStatus & number]: { data: null; error: TErrorsByStatus[S]; response: Response; status: S }
				}[keyof TErrorsByStatus & number])

export type ApiConfig<TThrow extends boolean = false> = Omit<SDKConfig, "baseURL" | "throwOnError"> & {
	/** Default: the document's first server, /api */
	baseURL?: string
	throwOnError?: TThrow
}

/** Every operation of the SDK, by its member path. */
export interface ApiOperations<TThrow extends boolean = false> {
	extract: {
		once(input: { params: { project_id: string }; form: CreateProjectsExtractRequest } & HttpOptions & { raw: true }): Promise<Response>
		once(input: { params: { project_id: string }; form: CreateProjectsExtractRequest } & HttpOptions & { raw?: false }): TThrow extends true ? Promise<CreateProjectsExtractResponse200> : Promise<SDKResult<CreateProjectsExtractResponse200>>
		stream(input: { params: { project_id: string }; form: CreateProjectsExtractRequest } & SseOptions): AsyncIterable<SSEEvent>
		table: {
			once(input: { params: { project_id: string; table_id: string }; form: CreateProjectsSuggestSchemaRequest } & HttpOptions & { raw: true }): Promise<Response>
			once(input: { params: { project_id: string; table_id: string }; form: CreateProjectsSuggestSchemaRequest } & HttpOptions & { raw?: false }): TThrow extends true ? Promise<CreateProjectsExtractResponse200> : Promise<SDKResult<CreateProjectsExtractResponse200>>
			stream(input: { params: { project_id: string; table_id: string }; form: CreateProjectsSuggestSchemaRequest } & SseOptions): AsyncIterable<SSEEvent>
		}
	}
	suggest: {
		schema(input: { params: { project_id: string }; form: CreateProjectsSuggestSchemaRequest } & HttpOptions & { raw: true }): Promise<Response>
		schema(input: { params: { project_id: string }; form: CreateProjectsSuggestSchemaRequest } & HttpOptions & { raw?: false }): TThrow extends true ? Promise<CreateProjectsExtractResponse200> : Promise<SDKResult<CreateProjectsExtractResponse200>>
	}
}
