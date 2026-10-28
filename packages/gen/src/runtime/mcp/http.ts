/**
 * MCP's Streamable HTTP transport (bit 21 d), web-standard (no node API): an Origin not its own nor listed 403, POST
 * alone 405, Accept naming JSON and SSE 406, JSON 415, a body past `max` as it streams 413. MCP-Protocol-Version picks
 * the era (absent: 2025-03-26); a modern request's headers match its body, else 400 -32020. No session id. JSON, or SSE
 * from a call's first progress. In 2026-07-28 a closed request or stream cancels its call. No path is read.
 */
import { decoded } from "./files.ts"
import { ErrorCode, failure, isId, type Reply } from "./jsonrpc.ts"
import { BATCHED, claimed, isObject, MODERN, type Protocol, PROTOCOL_VERSIONS, unserved, VERSION } from "./protocol.ts"

/** What the transport serves beside its own origin, and its body cap in bytes. */
export type HttpOptions = { readonly origins?: readonly string[]; readonly max?: number }

const SSE = { "cache-control": "no-cache", "content-type": "text/event-stream", "x-accel-buffering": "no" }

/** A response of `status`, `reply` its JSON body when given. */
const answered = (status: number, reply?: unknown) =>
	reply === undefined
		? new Response(null, { status })
		: new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" }, status })

/** A header's value as sent: a `=?base64?…?=` one decoded as UTF-8; undefined when absent or malformed. */
function valueOf(value: string | null): string | undefined {
	const encoded = /^=\?base64\?(.*)\?=$/.exec(value ?? "")?.[1]
	if (encoded === undefined) return value !== null && /^[\t\x20-\x7e]*$/.test(value) ? value : undefined
	const bytes = decoded(encoded)
	try {
		return bytes && new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		/* bytes that are no UTF-8 are malformed */
	} catch {
		return undefined
	}
}

/** `request`'s body as text, at most `max` bytes counted as they stream; undefined past it. */
async function bodyOf(request: Request, max: number): Promise<string | undefined> {
	const chunks: Uint8Array<ArrayBuffer>[] = []
	let size = 0
	const reader = request.body?.getReader()
	for (let read = await reader?.read(); read && !read.done; read = await reader?.read()) {
		if ((size += read.value.length) > max) return undefined
		chunks.push(read.value)
	}
	return new Blob(chunks).text()
}

/** The refusal of a request this endpoint takes no body from: its Origin, method, Accept or Content-Type. */
function unfit({ headers, method, url }: Request, origins: readonly string[]): Response | undefined {
	const origin = headers.get("origin")
	if (origin !== null && origin !== new URL(url).origin && !origins.includes(origin)) return answered(403)
	if (method !== "POST") return new Response(null, { headers: { allow: "POST" }, status: 405 })
	const accepts = (headers.get("accept") ?? "").split(",").map((type) => type.split(";")[0]?.trim().toLowerCase())
	if (!accepts.includes("application/json") || !accepts.includes("text/event-stream")) return answered(406)
	if (!/^application\/json *(;|$)/i.test(headers.get("content-type") ?? "")) return answered(415)
	return undefined
}

/** The header of a modern request's that disagrees with its body; undefined when none does. */
function mismatched(headers: Headers, method: unknown, params: Record<string, unknown>, version?: string) {
	if (claimed(params)?.[VERSION] !== version) return "MCP-Protocol-Version"
	if (headers.get("mcp-method") !== method) return "Mcp-Method"
	/* the body field Mcp-Name mirrors: a resource's uri, a tool's or a prompt's name */
	const field = method === "resources/read" ? "uri" : method === "tools/call" || method === "prompts/get" ? "name" : ""
	const named = params[field]
	return typeof named === "string" && valueOf(headers.get("mcp-name")) !== named ? "Mcp-Name" : undefined
}

/** A message's params, `{}` when it has none. */
const paramsOf = (message: Record<string, unknown>) => (isObject(message.params) ? message.params : {})

/** Whether `message` is a modern request: one with an id, its `_meta` claiming a revision or its header the modern. */
const modernOf = (message: Record<string, unknown>, version?: string) =>
	isId(message.id) && (claimed(paramsOf(message)) !== undefined || version === MODERN)

/** The refusal of a message its era rejects: a client's response in 2026-07-28; a modern request's header or `_meta`. */
function misheaded(message: Record<string, unknown>, headers: Headers, version?: string): Response | undefined {
	/* a client's response: taken before 2026-07-28, which forbids sending one */
	if (!("method" in message) && ("result" in message || "error" in message))
		return version === MODERN
			? answered(400, failure(null, ErrorCode.InvalidRequest, "Invalid Request: a client sends no response"))
			: answered(202)
	if (!modernOf(message, version)) return undefined
	const id = message.id as string | number
	const mismatch = mismatched(headers, message.method, paramsOf(message), version)
	if (mismatch) return answered(400, failure(id, ErrorCode.HeaderMismatch, `Header mismatch: ${mismatch}`))
	const meta = claimed(paramsOf(message))
	const refusal = meta && unserved(id, meta)
	return refusal ? answered(400, refusal) : undefined
}

/** A reply's status: a modern unknown method 404, a message JSON-RPC cannot read 400, else 200. */
function statusOf(reply: Reply | Reply[], modern: boolean): number {
	const code = "error" in reply ? reply.error.code : 0
	if (code === ErrorCode.MethodNotFound && modern) return 404
	return code === ErrorCode.ParseError || code === ErrorCode.InvalidRequest ? 400 : 200
}

/**
 * `protocol`'s answer to `body` under `version` as a Response: JSON, or an event stream once the call reports progress.
 * A modern request's call is cancelled by `closed` or its stream's close; a legacy one's by neither.
 */
function streamed(protocol: Protocol, body: unknown, version: string, closed?: AbortSignal) {
	const call = new AbortController()
	const signal = closed ? AbortSignal.any([closed, call.signal]) : call.signal
	return new Promise<Response>((settle) => {
		let stream: ReadableStreamDefaultController<Uint8Array> | undefined
		let open = true
		const write = (message: unknown) =>
			open && stream?.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`))
		const notify = (message: object) => {
			if (stream === undefined) {
				const cancel = () => void ((open = false), closed && call.abort())
				settle(new Response(new ReadableStream({ cancel, start: (each) => void (stream = each) }), { headers: SSE }))
			}
			write(message)
		}
		const answer = protocol.answer(body, { connection: { version }, notify, signal })
		void Promise.resolve(answer).then((reply) => {
			if (stream !== undefined) return void (write(reply), open && stream.close())
			settle(reply === undefined ? answered(202) : answered(statusOf(reply, closed !== undefined), reply))
		})
	})
}

/** The Streamable HTTP endpoint serving `protocol`: its own origin and `origins`, a body at most `max` bytes. */
export function serveHttp(protocol: Protocol, { max = 4_194_304, origins = [] }: HttpOptions = {}) {
	return async (request: Request): Promise<Response> => {
		const unfitting = unfit(request, origins)
		if (unfitting) return unfitting
		const text = await bodyOf(request, max)
		if (text === undefined) return answered(413)
		let body: unknown
		try {
			body = JSON.parse(text)
			/* a body that is no JSON is JSON-RPC's parse error */
		} catch {
			return answered(400, failure(null, ErrorCode.ParseError, "Parse error"))
		}
		const version = request.headers.get("mcp-protocol-version") ?? undefined
		if (version !== undefined && !(PROTOCOL_VERSIONS as readonly string[]).includes(version))
			return answered(
				400,
				failure(null, ErrorCode.UnsupportedProtocolVersion, "Unsupported protocol version", {
					requested: version,
					supported: PROTOCOL_VERSIONS,
				}),
			)
		const message = isObject(body) ? body : {}
		const refusal = misheaded(message, request.headers, version)
		if (refusal) return refusal
		return streamed(protocol, body, version ?? BATCHED, modernOf(message, version) ? request.signal : undefined)
	}
}
