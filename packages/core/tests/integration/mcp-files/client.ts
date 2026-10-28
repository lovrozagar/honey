/**
 * A minimal client of the io.modelcontextprotocol/files extension (bit 21 g; the draft at PR head 6101d34, :143-368),
 * since no shipping client implements it. It speaks 2026-07-28 over Streamable HTTP to `fetcher` (an app's own fetch,
 * in process, or the platform's), declaring the extension on every request. Its tools/call sends each file's
 * metadata; an `io.modelcontextprotocol/files/upload` input request is answered as the draft's client must: each
 * target checked (an absolute https URL, no Authorization, Cookie or forbidden header, `omit` sending no credential),
 * the bytes PUT, then the call retried with the same name and arguments, the echoed requestState and one outcome per
 * file. Each step can be altered by a leg (`retry`, `put`) to play a hostile or broken client.
 */

const EXTENSION = ["io.modelcontextprotocol", "files"].join("/")
const ACCEPT = "application/json, text/event-stream"
/* the request headers a target may never name (RFC 9110 credentials and the Fetch standard's forbidden ones) */
const FORBIDDEN =
	/^(?:authorization|cookie|cookie2|host|content-length|connection|keep-alive|te|trailer|transfer-encoding|upgrade|proxy-.*|sec-.*)$/i

export type Fetcher = (request: Request) => Promise<Response>

/** One upload target, as the server asked. */
export type Target = { fileId: string; url: string; headers?: Record<string, string>; credentials: string }

/** A JSON-RPC reply as read: its HTTP status, and its result or error. */
export type Replied = { status: number; result?: Record<string, unknown>; error?: { code: number; message: string } }

/** What a session saw: the first answer, each PUT's status, the retry's answer. */
export type Uploaded = { asked: Replied; targets: Target[]; puts: number[]; answered?: Replied }

/** How a leg alters the client: the bytes each PUT sends; the retry's params (its name among them) and headers. */
export type Altered = {
	readonly put?: (target: Target, bytes: Uint8Array) => BodyInit | null
	readonly retry?: (params: Record<string, unknown>) => Record<string, unknown>
	readonly retryHeaders?: Record<string, string>
}

/** A file's metadata as a FileInput: its id, name, type, size and SHA-256 (base64url, unpadded). */
export async function fileInput(id: string, bytes: Uint8Array, mimeType = "application/octet-stream") {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))
	const value = btoa(String.fromCharCode(...hash))
		.replace(/=+$/, "")
		.replaceAll("+", "-")
		.replaceAll("/", "_")
	return { digest: { algorithm: "sha-256", value }, id, mimeType, name: `${id}.bin`, size: bytes.length }
}

/** A 2026-07-28 request's `_meta`, declaring the extension unless `declared` is false. */
export const metaOf = (declared = true) => ({
	"io.modelcontextprotocol/clientCapabilities": declared ? { extensions: { [EXTENSION]: {} } } : {},
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
})

/** A 2026-07-28 tools/call of `name` to `endpoint`, its headers matching its body. */
export function toolCall(endpoint: string, name: string, params: Record<string, unknown>, headers = {}) {
	return new Request(endpoint, {
		body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { name, ...params } }),
		headers: {
			accept: ACCEPT,
			"content-type": "application/json",
			"mcp-method": "tools/call",
			"mcp-name": name,
			"mcp-protocol-version": "2026-07-28",
			...headers,
		},
		method: "POST",
	})
}

/** `response` as a JSON-RPC reply. */
export async function replied(response: Response): Promise<Replied> {
	const text = await response.text()
	const body = text === "" ? {} : (JSON.parse(text) as Omit<Replied, "status">)
	return { status: response.status, ...body }
}

/** Why a client refuses `target` (the draft's Upload targets rules 1 and 3), or undefined. */
export function unsafe(target: Target): string | undefined {
	if (!URL.canParse(target.url) || new URL(target.url).protocol !== "https:") return "not an absolute https URL"
	const named = Object.keys(target.headers ?? {}).find((name) => FORBIDDEN.test(name))
	return named === undefined ? undefined : `names the ${named} header`
}

/** A call with uploads: its endpoint, the headers its MCP requests carry, the tool, its arguments, each file's bytes. */
export type Call = {
	readonly endpoint: string
	readonly headers: Record<string, string>
	readonly name: string
	readonly args: Record<string, unknown>
	readonly bytes: Readonly<Record<string, Uint8Array>>
}

/**
 * `call` through `fetcher`, each file in its `bytes` (by FileInput id) uploaded when the server asks, the call retried:
 * what the session saw. Its headers go on the MCP requests alone, never on a PUT (`omit`).
 */
export async function callWithUploads(fetcher: Fetcher, call: Call, altered: Altered = {}): Promise<Uploaded> {
	const { args, bytes, endpoint, headers, name } = call
	const first = { _meta: metaOf(), arguments: args }
	const asked = await replied(await fetcher(toolCall(endpoint, name, first, headers)))
	if (asked.result?.resultType !== "input_required") return { asked, puts: [], targets: [] }
	const request = (asked.result.inputRequests as { uploads: { method: string; params: { files: Target[] } } }).uploads
	if (request.method !== `${EXTENSION}/upload`) throw new Error(`asked for ${request.method}`)
	const targets = request.params.files
	const puts: number[] = []
	for (const target of targets) {
		const refusal = unsafe(target)
		if (refusal !== undefined) throw new Error(`refused target ${target.fileId}: ${refusal}`)
		const own = bytes[target.fileId] as Uint8Array
		const body = altered.put ? altered.put(target, own) : (own as Uint8Array<ArrayBuffer>)
		const put = await fetcher(
			new Request(target.url, { body, duplex: "half", headers: target.headers, method: "PUT" } as RequestInit),
		)
		await put.body?.cancel()
		puts.push(put.status)
	}
	const files = targets.map((target, at) => ({
		fileId: target.fileId,
		status: (puts[at] as number) >= 200 && (puts[at] as number) < 300 ? "completed" : "failed",
	}))
	const params = {
		...first,
		inputResponses: { uploads: { files, resultType: "complete" } },
		name,
		requestState: asked.result.requestState,
	}
	const next = altered.retry ? altered.retry(params) : params
	const retry = toolCall(endpoint, String(next.name), next, altered.retryHeaders ?? headers)
	return { answered: await replied(await fetcher(retry)), asked, puts, targets }
}
