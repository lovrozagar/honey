import { ClientError } from "./error.ts";
import type { SSEEvent } from "./sse.ts";
import { parseSSEStream } from "./sse.ts";

export type HeadersContext = {
	method: string;
	path: string;
};

type HeadersRecord = Record<string, string | undefined>;

export type HeadersInit =
	| ((ctx: HeadersContext) => HeadersRecord | Promise<HeadersRecord>)
	| HeadersRecord;

export type RequestMeta = {
	invalidatedBy: string[]
	isStale: boolean
	selector: string
	seqSnapshot: number
}

export type OnRequestContext = {
	body?: BodyInit;
	headers: Headers;
	invalidatedBy?: string[]
	isStale?: boolean
	method: string;
	path: string;
	selector?: string
	state: Record<string, unknown>;
	url: string;
};

export type OnResponseContext = {
	invalidatedBy?: string[]
	isRetry: boolean;
	isStale?: boolean
	method: string;
	path: string;
	request: Request;
	response: Response;
	retry: () => Promise<Response>;
	selector?: string
	state: Record<string, unknown>;
	url: string;
};

export type ClientConfig = {
	baseURL: string;
	buildSearchParams?: (query: Record<string, unknown>) => URLSearchParams;
	credentials?: RequestCredentials;
	fetch?: typeof fetch;
	headers?: HeadersInit;
	mode?: RequestMode;
	onRequest?: Array<(ctx: OnRequestContext) => Promise<void> | void>;
	onResponse?: Array<
		(
			ctx: OnResponseContext,
		) => Promise<Response | undefined> | Response | undefined
	>;
	sortSearchParams?: boolean;
	state?: Record<string, unknown>;
	throwOnError?: boolean;
	timeout?: number;

	/* Realtime hooks — called by the generated runtime module */
	onAuthExpired?: () => Promise<string | null | undefined>;
	onReconnecting?: (attempt: number, transport: string) => void;
	onReconnected?: () => void;
};

export type RequestOptions = {
	cookies?: Record<string, string>;
	form?: Record<string, unknown>;
	headers?: Record<string, string>;
	json?: unknown;
	lastEventId?: string;
	params?: Record<string, string>;
	search?: Record<string, unknown>;
	signal?: AbortSignal;
};

export function interpolatePath(path: string, params: Record<string, string>): string {
	return path.replace(/:(\w+)/g, (_, key: string) => {
		const val = params[key];
		if (val === undefined) throw new Error(`Missing path param: ${key}`);
		return encodeURIComponent(val);
	});
}

function coerceParam(v: unknown): string | null {
	if (v === undefined || v === null) return null;
	if (v instanceof Date) return v.toISOString();
	if (typeof v === "symbol") return null;
	return String(v);
}

function defaultSearchParams(query: Record<string, unknown>): URLSearchParams {
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(query)) {
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) {
			for (const item of v) { const s = coerceParam(item); if (s !== null) params.append(k, s); }
		} else {
			const s = coerceParam(v); if (s !== null) params.set(k, s);
		}
	}
	return params;
}

function applySearch(
	url: URL,
	search: Record<string, unknown>,
	config: ClientConfig,
): void {
	const serializer = config.buildSearchParams ?? defaultSearchParams;
	const params = serializer(search);
	if (config.sortSearchParams) params.sort();
	for (const [k, v] of params.entries()) {
		url.searchParams.append(k, v);
	}
}

function buildURL(
	config: ClientConfig,
	path: string,
	opts: RequestOptions,
): string {
	let resolvedPath = path;
	if (opts.params) resolvedPath = interpolatePath(path, opts.params);

	const baseUrl = new URL(config.baseURL);
	const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
	const relative = resolvedPath.startsWith("/") ? resolvedPath.slice(1) : resolvedPath;
	const url = new URL(`${basePath}${relative}`, baseUrl);

	for (const [k, v] of baseUrl.searchParams.entries()) url.searchParams.append(k, v);
	if (opts.search) applySearch(url, opts.search, config);

	return url.toString();
}

async function buildHeaders(
	config: ClientConfig,
	opts: RequestOptions,
	ctx: HeadersContext,
): Promise<Headers> {
	const headers = new Headers();

	if (config.headers) {
		const resolved =
			typeof config.headers === "function"
				? await config.headers(ctx)
				: config.headers;
		for (const [k, v] of Object.entries(resolved)) {
			if (v !== undefined) headers.set(k, v);
		}
	}

	/* per-request headers override config headers */
	if (opts.headers) {
		for (const [k, v] of Object.entries(opts.headers)) {
			headers.set(k, v);
		}
	}

	if (opts.cookies) {
		const existing = headers.get("cookie");
		const pairs = Object.entries(opts.cookies)
			.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
			.join("; ");
		if (pairs) {
			headers.set("cookie", existing ? `${existing}; ${pairs}` : pairs);
		}
	}

	return headers;
}

function buildSignal(
	config: ClientConfig,
	opts: RequestOptions,
	isStream?: boolean,
): { signal: AbortSignal | undefined; cleanup: () => void } {
	const userSignal = opts.signal;
	/* skip timeout for streams — they're long-lived */
	const timeout = isStream ? undefined : config.timeout;

	if (!timeout) return { cleanup: () => {}, signal: userSignal };

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeout);
	if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
		(timer as unknown as { unref: () => void }).unref();
	}
	const onUserAbort = () => ctrl.abort(userSignal?.reason);
	if (userSignal?.aborted) {
		/* already aborted before we subscribed — propagate synchronously */
		ctrl.abort(userSignal.reason);
	} else {
		userSignal?.addEventListener("abort", onUserAbort, { once: true });
	}
	return {
		cleanup: () => {
			clearTimeout(timer);
			userSignal?.removeEventListener("abort", onUserAbort);
		},
		signal: ctrl.signal,
	};
}

async function parseErrorBody(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

async function parseErrorAsClientError(response: Response): Promise<ClientError> {
	const preserved = response.clone()
	const body = await parseErrorBody(response)
	const msgVal = typeof body === "object" && body !== null && "message" in body
		? (body as Record<string, unknown>).message
		: undefined
	const message = typeof msgVal === "string"
		/* oxlint-disable-next-line no-control-regex -- intentional strip of ASCII control characters */
		? msgVal.replace(/[\x00-\x1f]/g, "").slice(0, 512)
		: `HTTP ${response.status}`
	return new ClientError({ body, message, response: preserved, status: response.status })
}

export class HTTPClient {
	private _config: ClientConfig;
	private _fetch: typeof fetch;

	constructor(config: ClientConfig) {
		this._config = config;
		this._fetch = config.fetch ?? globalThis.fetch;
	}

	private async _doRequest(
		method: string,
		path: string,
		opts: RequestOptions,
		isRetry = false,
		_requestMeta?: RequestMeta,
	): Promise<{
		response: Response;
	}> {
		const url = buildURL(this._config, path, opts);
		const headers = await buildHeaders(this._config, opts, { method, path });
		let body: BodyInit | undefined;

		if (opts.json !== undefined) {
			headers.set("content-type", "application/json");
			body = JSON.stringify(opts.json);
		} else if (opts.form !== undefined) {
			const hasFiles = Object.values(opts.form).some(
				(v) =>
					(typeof File !== "undefined" && v instanceof File) ||
					(typeof Blob !== "undefined" && v instanceof Blob) ||
					(typeof FileList !== "undefined" && v instanceof FileList) ||
					(Array.isArray(v) &&
						v.some(
							(item) =>
								(typeof File !== "undefined" && item instanceof File) ||
								(typeof Blob !== "undefined" && item instanceof Blob),
						)),
			);

			if (hasFiles) {
				const fd = new FormData();
				for (const [k, v] of Object.entries(opts.form)) {
					if (v === undefined || v === null) continue;
					if (typeof FileList !== "undefined" && v instanceof FileList) {
						for (let i = 0; i < v.length; i++) { const f = v[i]; if (f) fd.append(k, f) }
					} else if (Array.isArray(v)) {
						for (const item of v) {
							if (item instanceof File || item instanceof Blob)
								fd.append(k, item);
							else { const s = coerceParam(item); if (s !== null) fd.append(k, s); }
						}
					} else if (v instanceof File || v instanceof Blob) {
						fd.append(k, v);
					} else {
						const s = coerceParam(v); if (s !== null) fd.append(k, s);
					}
				}
				/* don't set content-type — browser sets multipart boundary */
				body = fd;
			} else {
				headers.set("content-type", "application/x-www-form-urlencoded");
				const params = new URLSearchParams();
				for (const [k, v] of Object.entries(opts.form)) {
					const s = coerceParam(v); if (s !== null) params.set(k, s);
				}
				body = params.toString();
			}
		}

		/* onRequest interceptors */
		if (this._config.onRequest) {
			const reqCtx: OnRequestContext = { body, headers, method, path, state: this._config.state ?? {}, url }
			if (_requestMeta) {
				reqCtx.invalidatedBy = _requestMeta.invalidatedBy
				reqCtx.isStale = _requestMeta.isStale
				reqCtx.selector = _requestMeta.selector
			}
			for (const hook of this._config.onRequest) {
				await hook(reqCtx);
			}
			if (reqCtx.body !== body) body = reqCtx.body;
		}

		const { signal, cleanup } = buildSignal(this._config, opts);
		const init: RequestInit = { body, headers, method, signal };

		if (this._config.credentials) init.credentials = this._config.credentials;
		if (this._config.mode) init.mode = this._config.mode;

		try {
			/* fail fast if the signal is already aborted — matches native fetch semantics */
			signal?.throwIfAborted();
			let response = await this._fetch(url, init);

			/* onResponse interceptors */
			if (this._config.onResponse) {
				const resCtx: OnResponseContext = {
					isRetry,
					method,
					path,
					request: new Request(url, init),
					response,
					retry: () => {
						if (isRetry) throw new Error("Max 1 retry per request")
						return this._doRequest(method, path, opts, true, _requestMeta).then(
							async (r) => {
								if (!r.response.ok) throw await parseErrorAsClientError(r.response)
								return r.response
							},
						)
					},
					state: this._config.state ?? {},
					url,
				}
				if (_requestMeta) {
					resCtx.invalidatedBy = _requestMeta.invalidatedBy
					resCtx.isStale = _requestMeta.isStale
					resCtx.selector = _requestMeta.selector
				}
				for (const hook of this._config.onResponse) {
					const result = await hook(resCtx);
					if (result instanceof Response) {
						response = result;
						resCtx.response = result;
					}
				}
			}

			return { response };
		} finally {
			cleanup();
		}
	}

	private _parseBody(response: Response): Promise<unknown> {
		if (response.status === 204) return Promise.resolve(null)
		const rawCt = response.headers.get("content-type") ?? ""
		const ct = rawCt.split(";")[0]?.trim().toLowerCase() ?? ""
		if (ct === "application/json" || ct.endsWith("+json")) {
			return response.json()
		}
		if (ct === "application/octet-stream" || ct === "application/pdf") {
			return response.arrayBuffer()
		}
		if (ct.startsWith("text/")) return response.text()
		return response.arrayBuffer()
	}

	/** Throw mode — throws ClientError on non-2xx */
	async request(
		method: string,
		path: string,
		opts: RequestOptions,
		_requestMeta?: RequestMeta,
	): Promise<unknown> {
		const { response } = await this._doRequest(method, path, opts, false, _requestMeta);

		if (!response.ok) {
			throw await parseErrorAsClientError(response);
		}

		return this._parseBody(response);
	}

	/** Safe mode — returns { data, error, response, status } — error is the raw parsed body */
	async requestSafe(
		method: string,
		path: string,
		opts: RequestOptions,
		_requestMeta?: RequestMeta,
	): Promise<{
		data: unknown;
		error: unknown;
		response: Response;
		status: number;
	}> {
		const { response } = await this._doRequest(method, path, opts, false, _requestMeta);

		if (!response.ok) {
			const preserved = response.clone();
			const error = await parseErrorBody(response);
			return {
				data: null,
				error,
				response: preserved,
				status: response.status,
			};
		}

		let data: unknown;
		try {
			data = await this._parseBody(response);
		} catch (e) {
			return { data: null, error: e, response, status: response.status };
		}
		return { data, error: null, response, status: response.status };
	}

	requestStream(
		method: string,
		path: string,
		opts: RequestOptions,
	): AsyncIterable<SSEEvent> {
		return {
			[Symbol.asyncIterator]: () => this._doStream(method, path, opts),
		};
	}

	private async *_doStream(
		method: string,
		path: string,
		opts: RequestOptions,
	): AsyncGenerator<SSEEvent, void, undefined> {
		const url = buildURL(this._config, path, opts);
		const headers = await buildHeaders(this._config, opts, { method, path });
		headers.set("accept", "text/event-stream");

		if (opts.lastEventId) {
			headers.set("last-event-id", opts.lastEventId);
		}

		/* no timeout on streams — they're long-lived, but user abort still composes */
		const { signal, cleanup } = buildSignal(this._config, opts, true);
		const init: RequestInit = { headers, method, signal };

		if (this._config.credentials) init.credentials = this._config.credentials;
		if (this._config.mode) init.mode = this._config.mode;

		try {
			signal?.throwIfAborted();
			const response = await this._fetch(url, init);

			if (!response.ok) {
				throw await parseErrorAsClientError(response);
			}

			if (!response.body) return;

			yield* parseSSEStream(response.body);
		} finally {
			cleanup();
		}
	}

	buildUrl(path: string, opts: RequestOptions): string {
		return buildURL(this._config, path, opts);
	}

	buildPath(path: string, opts: RequestOptions): string {
		let resolved = path;
		if (opts.params) {
			resolved = interpolatePath(path, opts.params);
		}

		if (!opts.search) return resolved;

		const serializer = this._config.buildSearchParams ?? defaultSearchParams;
		const params = serializer(opts.search);
		if (this._config.sortSearchParams) params.sort();

		const qs = params.toString();
		return qs ? `${resolved}?${qs}` : resolved;
	}

	buildWSUrl(path: string, opts: RequestOptions): string {
		const url = buildURL(this._config, path, opts);
		return url.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
	}
}
