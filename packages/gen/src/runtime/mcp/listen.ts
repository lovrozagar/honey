/**
 * The standalone Streamable HTTP server (bit 21 d): node's http adapting http.ts's handler at /mcp alone. Unless exposed,
 * a Host not a loopback name with the bound port is 421 (DNS rebinding). With a token, a request carries it as its
 * bearer, compared in constant time, else 401. A response closed early aborts its request's signal.
 */
import { createHash, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { pipeline, Readable } from "node:stream"

/** Where the server listens, its token when it has one, and whether it answers for any Host. */
export type Listen = {
	readonly host: string
	readonly port: number
	readonly token?: string
	readonly exposed?: boolean
}

const digest = (text: string) => createHash("sha256").update(text).digest()

/** Whether `authorization` carries `token` as its bearer: their digests compared in constant time. */
export const bearer = (authorization: string | null, token: string): boolean =>
	timingSafeEqual(digest(/^Bearer (.+)$/i.exec(authorization ?? "")?.[1] ?? ""), digest(token))

/** `incoming` as a Request to `url`, every header kept as sent (a repeated one joined), `closed` its signal. */
function requestOf(incoming: IncomingMessage, headers: Headers, url: string, closed: AbortSignal) {
	const post = incoming.method === "POST"
	const body = post ? (Readable.toWeb(incoming) as ReadableStream) : null
	return new Request(url, { body, duplex: "half", headers, method: incoming.method, signal: closed } as RequestInit)
}

/**
 * The answer to `incoming` at `port`: a Host not served 421, no token 401, another path 404, else `handler`'s, its
 * request's signal `closed`.
 */
async function answerOf(
	incoming: IncomingMessage,
	handler: (request: Request) => Promise<Response>,
	{ exposed, port, token }: Listen,
	closed: AbortSignal,
): Promise<Response> {
	const headers = new Headers()
	for (let at = 0; at < incoming.rawHeaders.length; at += 2)
		headers.append(incoming.rawHeaders[at] as string, incoming.rawHeaders[at + 1] as string)
	const host = headers.get("host")?.toLowerCase()
	if (!exposed && !["localhost", "127.0.0.1", "[::1]"].some((name) => host === `${name}:${port}`))
		return new Response(null, { status: 421 })
	if (token !== undefined && !bearer(headers.get("authorization"), token))
		return new Response(null, { headers: { "www-authenticate": "Bearer" }, status: 401 })
	if (incoming.url?.split("?")[0] !== "/mcp") return new Response(null, { status: 404 })
	try {
		return await handler(requestOf(incoming, headers, `http://${host}/mcp`, closed))
		/* a Request node cannot make (a Host no URL holds, a method fetch forbids) or a body cut mid-read */
	} catch {
		return new Response(null, { status: 400 })
	}
}

/** `handler` served at /mcp on `listen`'s host and port; settles once it listens. */
export function listenHttp(handler: (request: Request) => Promise<Response>, listen: Listen): Promise<Server> {
	const server = createServer(async (incoming, outgoing) => {
		const closed = new AbortController()
		outgoing.once("close", () => outgoing.writableFinished || closed.abort())
		const { port } = server.address() as AddressInfo
		const response = await answerOf(incoming, handler, { ...listen, port }, closed.signal)
		outgoing.writeHead(response.status, Object.fromEntries(response.headers))
		/* a response closed early destroys its source, which cancels the body's stream; closed already, it is cancelled */
		if (response.body && !outgoing.destroyed)
			pipeline(Readable.fromWeb(response.body as never), outgoing, () => undefined)
		else void (response.body?.cancel(), outgoing.end())
	})
	return new Promise((settle, reject) => {
		server.once("error", reject)
		server.listen(listen.port, listen.host, () => settle(server))
	})
}
