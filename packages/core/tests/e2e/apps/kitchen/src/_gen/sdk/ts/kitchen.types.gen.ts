import type { Result, SDKConfig, SSEEvent, TypedWebSocket } from "./kitchen.runtime.gen"

export type CreateApiV1OrganizationResponse409 = {
	error_key: "org_slug_taken"
	fields: Record<string, { error_key: string; message: string; path: string }[]>
	message: string
	status: 409
	status_key: string
	success: false
}
export type Err400InvalidInput = {
	error_key: "invalid_input"
	fields: Record<string, { error_key: string; message: string; path: string }[]>
	message: string
	status: 400
	status_key: string
	success: false
}
export type Err401Unauthorized = {
	error_key: "unauthorized"
	fields: Record<string, { error_key: string; message: string; path: string }[]>
	message: string
	status: 401
	status_key: string
	success: false
}
export type Err403OrgLimitReached = {
	error_key: "org_limit_reached"
	fields: Record<string, { error_key: string; message: string; path: string }[]>
	message: string
	status: 403
	status_key: string
	success: false
}
export type Err500ApiError = {
	error_key: "api_error"
	fields: Record<string, { error_key: string; message: string; path: string }[]>
	message: string
	status: 500
	status_key: string
	success: false
}
export type ListApiEventsResponse200 = string
export type ListApiResponse200 = { id: string }

/** The order.paid webhook event */
export type OrderPaidWebhookEvent = {
	id: string
	known: true
	type: "order.paid"
	timestamp: string
	data: { amount: number; orderId: string }
}
/** The order.refunded webhook event */
export type OrderRefundedWebhookEvent = {
	id: string
	known: true
	type: "order.refunded"
	timestamp: string
	data: { orderId: string; reason: string }
}
/** An event of a type this SDK's document does not declare: a newer API's, its data as sent. */
export type UnknownWebhookEvent = { id: string; known: false; type: string; timestamp: string; data: unknown }
/** A verified delivery: check `known`, then switch on `type` for its typed `data`. */
export type WebhookEvent = OrderPaidWebhookEvent | OrderRefundedWebhookEvent | UnknownWebhookEvent

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

/* a call's declared errors and headers, which only its safe twin reads: a type, never a value */
declare const answer: unique symbol

/** A call's input: optional when none of its fields is required. */
type HoneyArgs<I, O> = {} extends I ? [input?: I & O] : [input: I & O]

/** A REST operation: its raw overload and its value, an error status thrown; its declared errors and headers. */
type HoneyCall<I, D, E = never, H = never> = {
	(input: I & HttpOptions & { raw: true }): Promise<Response>
	(...input: HoneyArgs<I, HttpOptions & { raw?: false }>): Promise<D>
	readonly [answer]?: [E, H]
}

/** An event stream, sent when its iteration starts; its opening answer's declared errors. */
type HoneyStream<I, V, E = never> = {
	(...input: HoneyArgs<I, SseOptions>): AsyncIterable<V>
	readonly [answer]?: [E, never]
}

/** `client.safe`: every REST and stream call answering a Result, never throwing an API answer; a connection as is. */
export type HoneySafe<T> = {
	[K in keyof T]: T[K] extends (...input: never[]) => TypedWebSocket
		? T[K]
		: T[K] extends HoneyCall<infer I, infer D, infer E, infer H>
			? {
					(input: I & HttpOptions & { raw: true }): Promise<Result<Response, E>>
					(...input: HoneyArgs<I, HttpOptions & { raw?: false }>): Promise<Result<D, E, H>>
				}
			: T[K] extends HoneyStream<infer I, infer V, infer E>
				? (...input: HoneyArgs<I, SseOptions>) => Promise<Result<AsyncIterable<V>, E>>
				: HoneySafe<T[K]>
}

export type KitchenConfig = SDKConfig

/** Every operation of the SDK, by its member path. */
export interface KitchenOperations {
	deleteApiEcho: HoneyCall<{}, null, { 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }>
	deleteApiV1OrganizationsByOrgId: HoneyCall<
		{ params: { orgId: string } },
		null,
		{ 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }
	>
	/**
	 * Root test route
	 *
	 * Test route
	 */
	getApi: HoneyCall<
		{ search: { id: string } },
		ListApiResponse200,
		{
			400: ErrorEnvelope<400, "invalid_input">
			401: ErrorEnvelope<401, "unauthorized">
			500: ErrorEnvelope<500, "api_error">
		}
	>
	getApiBoundaryCustom: HoneyCall<
		{},
		null,
		{
			401: ErrorEnvelope<401, "unauthorized">
			403: ErrorEnvelope<403, "org_limit_reached">
			500: ErrorEnvelope<500, "api_error">
		}
	>
	getApiBoundaryDefault: HoneyCall<
		{},
		null,
		{ 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }
	>
	getApiEcho: HoneyCall<{}, null, { 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }>
	getApiEchoWs(input?: WsOptions): TypedWebSocket
	getApiEvents: HoneyStream<
		{},
		SSEEvent,
		{ 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }
	>
	getApiEventsLive: HoneyStream<
		{},
		SSEEvent,
		{ 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }
	>
	getApiHealth: HoneyCall<{}, null, { 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }>
	getApiRealtimeChatByRoomId(input: { params: { roomId: string } } & WsOptions): TypedWebSocket
	getApiRealtimeEcho(input?: WsOptions): TypedWebSocket
	getApiReconnectWs(input?: WsOptions): TypedWebSocket
	getApiV1Organizations: HoneyCall<
		{},
		null,
		{ 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }
	>
	getApiV1OrganizationsByOrgId: HoneyCall<
		{ params: { orgId: string } },
		null,
		{ 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }
	>
	getApiV1Socket(input?: WsOptions): TypedWebSocket
	patchApiEcho: HoneyCall<{}, null, { 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }>
	postApiEcho: HoneyCall<{}, null, { 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }>
	postApiRealtimeBroadcastByTopic: HoneyCall<
		{ params: { topic: string } },
		null,
		{ 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }
	>
	postApiV1Organizations: HoneyCall<
		{},
		null,
		{
			400: ErrorEnvelope<400, "invalid_input">
			401: ErrorEnvelope<401, "unauthorized">
			403: ErrorEnvelope<403, "org_limit_reached">
			409: ErrorEnvelope<409, "org_slug_taken">
			500: ErrorEnvelope<500, "api_error">
		}
	>
	putApiEcho: HoneyCall<{}, null, { 401: ErrorEnvelope<401, "unauthorized">; 500: ErrorEnvelope<500, "api_error"> }>
}

/** `client.safe`: every operation, a call answering a Result. */
export type KitchenSafe = HoneySafe<KitchenOperations>
