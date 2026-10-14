/**
 * Real `node:http` parsing for the bridge's unit tests: raw request bytes go over a loopback
 * socket and come back as the IncomingMessage the adapter would get, body still on the socket.
 */
import { createServer, type IncomingMessage, type Server } from "node:http"
import { connect, type Socket } from "node:net"

export type RawRequest = {
	/** body parts, each written after the previous one was sent */
	readonly body?: readonly string[]
	/** frame the body as `Transfer-Encoding: chunked`, one chunk per part */
	readonly chunked?: boolean
	/** header lines in order; repeats stay repeats. Default: `Host: app.example`. A body gets its
	 * `Content-Length` unless these frame it already */
	readonly headers?: readonly (readonly [string, string])[]
	readonly method?: string
	readonly target?: string
	readonly version?: "1.0" | "1.1"
}

function head(init: RawRequest): string {
	const headers = init.headers ?? [["Host", "app.example"]]
	const lines = headers.map(([name, value]) => `${name}: ${value}\r\n`)
	const framed = headers.some(([name]) => /^(?:content-length|transfer-encoding)$/i.test(name))
	if (init.chunked === true) lines.push("Transfer-Encoding: chunked\r\n")
	else if (init.body !== undefined && !framed)
		lines.push(`Content-Length: ${Buffer.byteLength(init.body.join(""))}\r\n`)
	return `${init.method ?? "GET"} ${init.target ?? "/"} HTTP/${init.version ?? "1.1"}\r\n${lines.join("")}\r\n`
}

function frame(part: string, chunked: boolean): string {
	return chunked ? `${Buffer.byteLength(part).toString(16)}\r\n${part}\r\n` : part
}

async function writeBody(client: Socket, init: RawRequest): Promise<void> {
	const chunked = init.chunked === true
	for (const part of init.body ?? []) {
		await new Promise((resolve) => setTimeout(resolve, 2))
		client.write(frame(part, chunked))
	}
	if (chunked) client.write("0\r\n\r\n")
}

/** A parser: `parse(raw)` answers with the IncomingMessage; `close()` ends every socket and server. */
export function httpParser(): { close(): Promise<void>; parse(init?: RawRequest): Promise<IncomingMessage> } {
	const servers: Server[] = []
	const clients: Socket[] = []
	async function parse(init: RawRequest = {}): Promise<IncomingMessage> {
		const server = createServer()
		servers.push(server)
		const received = new Promise<IncomingMessage>((resolve) => server.once("request", resolve))
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const { port } = server.address() as { port: number }
		const client = connect(port, "127.0.0.1")
		clients.push(client)
		client.on("error", () => {})
		client.write(head(init))
		void writeBody(client, init)
		return received
	}
	async function close(): Promise<void> {
		for (const client of clients.splice(0)) client.destroy()
		await Promise.all(
			servers.splice(0).map(
				(server) =>
					new Promise<void>((resolve) => {
						server.closeAllConnections()
						server.close(() => resolve())
					}),
			),
		)
	}
	return { close, parse }
}
