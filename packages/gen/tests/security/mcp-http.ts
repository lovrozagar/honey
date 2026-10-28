/**
 * The tools and requests the MCP Streamable HTTP corpus (bit 21 d) shares: a protocol over `echo` and `café` (each
 * recording its call), `hold` (progress 1, then waits for its abort or a release, recording which) and `upload`, a
 * bound multipart tool whose SDK client records what it would send; Requests as a conforming client sends them; an
 * answer read whole. The runtime's own modules alone.
 */
import { bindTools } from "../../src/runtime/mcp/call.ts"
import { createProtocol, type Tool } from "../../src/runtime/mcp/protocol.ts"

export const URL_MCP = "http://127.0.0.1:8000/mcp"
export const ACCEPT = "application/json, text/event-stream"
export const MODERN = "2026-07-28"
export const META = {
	"io.modelcontextprotocol/clientCapabilities": {},
	"io.modelcontextprotocol/protocolVersion": MODERN,
}
/** A modern tools/call's three headers for the tool `name`. */
export const modernHeaders = (name: string) => ({
	"mcp-method": "tools/call",
	"mcp-name": name,
	"mcp-protocol-version": MODERN,
})

/** Every call the recording tools saw, how each held call ended, the held calls' releases, what upload sent. */
export const seen: string[] = []
export const ended: string[] = []
export const held = new Set<() => void>()
export const sent: unknown[] = []

/** A tool named `name` that records its call and answers ok. */
const recording = (name: string): Tool => ({
	call: async () => {
		seen.push(name)
		return { content: [{ text: "ok", type: "text" }] }
	},
	inputSchema: { type: "object" },
	name,
})

/** `hold`: progress 1, then waits for its abort or a release, records which, and answers. */
const hold: Tool = {
	call: async (_, signal, progress) => {
		progress(1)
		await new Promise<void>((settle) => {
			held.add(settle)
			if (signal.aborted) settle()
			signal.addEventListener("abort", () => settle())
		})
		ended.push(signal.aborted ? "aborted" : "released")
		return { content: [{ text: "held", type: "text" }] }
	},
	inputSchema: { type: "object" },
	name: "hold",
}

/** The SDK client `upload` calls: records each input, answers 200. */
const client = {
	docs: {
		upload: async (input: unknown) => {
			sent.push(input)
			return { data: {}, error: undefined, response: new Response("{}"), status: 200 }
		},
	},
}
const upload = bindTools(
	[
		{
			args: [],
			inputSchema: { properties: { file: { type: "object" } }, type: "object" },
			member: ["docs", "upload"],
			name: "upload",
			parts: [["file", "file", "file"]],
		},
	],
	client,
	{ opening: () => client, secrets: [], timeout: 5_000 },
)

export const protocol = createProtocol({ name: "corpus", version: "1.0.0" }, [
	recording("echo"),
	recording("café"),
	hold,
	...upload,
])

/** Settles once `held` holds `count` calls. */
export const holding = async (count: number): Promise<void> => {
	while (held.size < count) await new Promise((settle) => setImmediate(settle))
}

/** Settles with how the `count`th held call ended, once it has. */
export const nextEnd = async (count: number): Promise<string | undefined> => {
	while (ended.length < count) await new Promise((settle) => setImmediate(settle))
	return ended[count - 1]
}

/** Releases every held call. */
export const release = (): void => {
	for (const settle of held) settle()
	held.clear()
}

/** A request to `handler` of `body`, the headers a conforming client sends beside `headers`. */
export const posting =
	(handler: (request: Request) => Promise<Response>, url = URL_MCP) =>
	(body: unknown, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<Response> =>
		handler(
			new Request(url, {
				body: typeof body === "string" ? body : JSON.stringify(body),
				headers: { accept: ACCEPT, "content-type": "application/json", ...headers },
				method: "POST",
				...init,
			}),
		)

export type Answer = { status: number; headers: Headers; text: string; json: Record<string, unknown> | undefined }

/** `response` read whole, its JSON when it is JSON. */
export async function read(response: Response): Promise<Answer> {
	const text = await response.text()
	let json: Record<string, unknown> | undefined
	try {
		json = JSON.parse(text) as Record<string, unknown>
		/* an empty or event-stream body is no JSON */
	} catch {
		json = undefined
	}
	return { headers: response.headers, json, status: response.status, text }
}

/** An answer's status and JSON-RPC error code. */
export const codeOf = (answer: Answer): [number, number | undefined] => [
	answer.status,
	(answer.json?.error as { code?: number } | undefined)?.code,
]

/** A result's isError and its first text block parsed. */
export const resultOf = (answer: Answer): [boolean | undefined, unknown] => {
	const result = answer.json?.result as { content?: { text?: string }[]; isError?: boolean } | undefined
	return [result?.isError, JSON.parse(result?.content?.[0]?.text ?? "null")]
}
